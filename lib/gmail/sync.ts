import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "./crypto";
import { classifyCategory } from "./classifier";
import { decodeBase64Url, parseNubankTransaction, type ParsedNubankTransaction } from "./parser";
import { getAccessToken, gmailFetch, startGmailWatch, type GmailConnection } from "./google";

type Header = { name: string; value: string };
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };
type GmailMessage = { id: string; internalDate?: string; payload?: Part & { headers?: Header[] } };
type Route = {
  id: string;
  profile_id: string;
  account_id: string | null;
  match_label: string;
  is_default: boolean;
  priority: number;
};
type Account = {
  id: string;
  profile_id: string;
  name: string;
  kind: string;
  institution: string | null;
  email_aliases: string[] | null;
};
type Category = { id: string; name: string; is_income: boolean; profile_id?: string | null };
type ImportOptions = { replaceExisting?: boolean };
type GmailMessageList = { messages?: { id: string }[]; nextPageToken?: string };

const key = (value: string | null | undefined) =>
  (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

function header(message: GmailMessage, name: string) {
  return message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function textFromPart(part?: Part): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  const children = part.parts?.map(textFromPart).filter(Boolean).join("\n") ?? "";
  if (children) return children;
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  return "";
}

function trustedNubank(message: GmailMessage) {
  const from = header(message, "from").toLowerCase();
  const auth = header(message, "authentication-results").toLowerCase();
  return /@(?:[\w-]+\.)?nubank\.com\.br\b/.test(from)
    && /(?:dkim|spf)=pass/.test(auth)
    && auth.includes("nubank.com.br");
}

function keywordCategory(description: string, categories: Category[]) {
  const text = key(description);
  const rules: [RegExp, string[]][] = [
    [/mercado|supermercado|atacadao|assai|carrefour|hortifruti|padaria/, ["mercado", "alimentacao"]],
    [/posto|combustivel|shell|ipiranga|gasolina|etanol/, ["combustivel", "transporte"]],
    [/uber|99\b|taxi|onibus|metro|estacionamento|pedagio/, ["transporte"]],
    [/netflix|spotify|prime|youtube|disney|hbo|max\.com/, ["assinatura", "entretenimento"]],
    [/farmacia|drogaria|hospital|clinica|laboratorio|medico/, ["saude"]],
    [/restaurante|ifood|lanchonete|burger|pizza|sushi|cafe/, ["alimentacao"]],
    [/escola|faculdade|curso|livraria|udemy/, ["educacao"]],
    [/aluguel|condominio|energia|internet|telefone|agua|gas/, ["moradia", "casa"]],
    [/cinema|futebol|show|ingresso|jogo/, ["lazer", "entretenimento"]],
    [/roupa|calcado|renner|riachuelo|cea\b/, ["roupa", "vestuario"]],
  ];
  const wanted = rules.find(([pattern]) => pattern.test(text))?.[1] ?? [];
  return categories.find((category) => wanted.some((term) => key(category.name).includes(term)))?.id ?? null;
}

function chooseRoute(routes: Route[], parsed: ParsedNubankTransaction, fallbackProfileId: string) {
  const label = key(parsed.accountLabel);
  const ordered = [...routes].sort((a, b) => a.priority - b.priority);
  const matched = ordered.find((route) => {
    const match = key(route.match_label);
    return match !== "*" && (label.includes(match) || match.includes(label));
  });
  return matched ?? ordered.find((route) => route.is_default) ?? {
    id: null,
    profile_id: fallbackProfileId,
    account_id: null,
  };
}

function chooseAccount(accounts: Account[], route: ReturnType<typeof chooseRoute>, parsed: ParsedNubankTransaction) {
  if (route.account_id) return accounts.find((account) => account.id === route.account_id) ?? null;
  const label = key(parsed.accountLabel);
  return accounts.find((account) =>
    account.profile_id === route.profile_id
    && account.kind === parsed.accountKind
    && [account.name, account.institution, ...(account.email_aliases ?? [])]
      .some((candidate) => {
        const normalized = key(candidate);
        return normalized && (normalized.includes(label) || label.includes(normalized));
      }),
  ) ?? null;
}

async function importMessage(
  connection: GmailConnection,
  accessToken: string,
  messageId: string,
  options: ImportOptions = {},
) {
  const admin = createAdminClient();
  const message = await gmailFetch<GmailMessage>(accessToken, `/messages/${messageId}?format=full`);
  const subject = header(message, "subject").slice(0, 240);
  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : new Date().toISOString();
  const { data: existingImport, error: existingImportError } = options.replaceExisting
    ? await admin.from("email_imports").select("id,transaction_id,status").eq("gmail_message_id", message.id).maybeSingle()
    : { data: null, error: null };
  if (existingImportError) throw existingImportError;
  let importId = existingImport?.id as string | undefined;
  const previousTransactionId = existingImport?.transaction_id as string | null | undefined;

  if (!importId) {
    const { data: claimedImport, error: claimError } = await admin.from("email_imports").insert({
      user_id: connection.user_id,
      profile_id: connection.profile_id,
      gmail_message_id: message.id,
      subject,
      received_at: receivedAt,
      parser_version: 2,
    }).select("id").single();
    if (claimError?.code === "23505") return "duplicate";
    if (claimError) throw claimError;
    importId = claimedImport.id;
  }

  try {
    if (!trustedNubank(message)) {
      if (previousTransactionId) return "preserved";
      await admin.from("email_imports").update({
        subject, received_at: receivedAt, status: "ignored",
        error: "Remetente não autenticado como Nubank",
      }).eq("id", importId);
      return "ignored";
    }
    const parsed = parseNubankTransaction(subject, textFromPart(message.payload), receivedAt);
    if (!parsed) {
      if (previousTransactionId) return "preserved";
      await admin.from("email_imports").update({
        subject, received_at: receivedAt, status: "ignored",
        error: "Não é uma notificação de transação reconhecida",
      }).eq("id", importId);
      return "ignored";
    }

    const [{ data: routes }, { data: categories }] = await Promise.all([
      admin.from("gmail_import_routes").select("id,profile_id,account_id,match_label,is_default,priority").eq("user_id", connection.user_id).eq("active", true),
      admin.from("categories").select("id,name,is_income,profile_id").eq("archived", false),
    ]);
    const route = chooseRoute((routes ?? []) as Route[], parsed, connection.profile_id);
    const { data: accounts } = await admin
      .from("accounts")
      .select("id,profile_id,name,kind,institution,email_aliases")
      .eq("profile_id", route.profile_id)
      .eq("active", true);
    const account = chooseAccount((accounts ?? []) as Account[], route, parsed);
    const allCategories = ((categories ?? []) as Category[]).filter((category) => !category.profile_id || category.profile_id === route.profile_id);
    const hinted = parsed.categoryHint
      ? allCategories.find((category) => key(category.name) === key(parsed.categoryHint))?.id ?? null
      : null;
    let categoryId = hinted;
    if (parsed.transactionType === "expense" && !categoryId) {
      categoryId = keywordCategory(parsed.description, allCategories.filter((category) => !category.is_income));
      if (!categoryId) categoryId = await classifyCategory(parsed.description, subject, allCategories.filter((category) => !category.is_income));
    }
    const needsReview = parsed.needsReview || (parsed.transactionType === "expense" && !categoryId);
    const transactionPayload = {
      profile_id: route.profile_id,
      account_id: account?.id ?? null,
      category_id: categoryId,
      description: parsed.description,
      amount: parsed.amount,
      occurred_at: parsed.occurredAt ?? receivedAt.slice(0, 10),
      transaction_type: parsed.transactionType,
      counterparty: parsed.counterparty,
      account_label: parsed.accountLabel,
      metadata: { parser_version: 2, gmail_subject: subject },
      paid_by_user_id: connection.user_id,
      source: "email",
      needs_review: needsReview,
      raw_text: `gmail:${message.id} | ${subject}`,
    };

    let transactionId = previousTransactionId;
    if (transactionId) {
      const { error: transactionError } = await admin.from("transactions").update(transactionPayload).eq("id", transactionId);
      if (transactionError) throw transactionError;
    } else {
      const { data: transaction, error: transactionError } = await admin.from("transactions")
        .insert(transactionPayload).select("id").single();
      if (transactionError) throw transactionError;
      transactionId = transaction.id;
    }

    const { error: importUpdateError } = await admin.from("email_imports").update({
      profile_id: route.profile_id,
      route_id: route.id,
      subject,
      received_at: receivedAt,
      status: "imported",
      transaction_id: transactionId,
      parser_version: 2,
      parsed_payload: parsed,
      error: null,
    }).eq("id", importId);
    if (importUpdateError) throw importUpdateError;
    return previousTransactionId ? "updated" : "imported";
  } catch (error) {
    await admin.from("email_imports").update({
      error: error instanceof Error ? error.message.slice(0, 500) : "Erro desconhecido",
    }).eq("id", importId);
    throw error;
  }
}

async function listGmailMessageIds(accessToken: string, query: string) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: "100", q: query });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await gmailFetch<GmailMessageList>(accessToken, `/messages?${params}`);
    ids.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < 5000);
  return ids;
}
export async function validateGmailConnection(connection: GmailConnection) {
  const accessToken = await getAccessToken(decryptToken(connection.encrypted_refresh_token));
  await gmailFetch<{ messages?: { id: string }[] }>(accessToken, "/messages?maxResults=1");
}

export async function syncGmailConnection(connection: GmailConnection, options: ImportOptions = {}) {
  const admin = createAdminClient();
  try {
    const accessToken = await getAccessToken(decryptToken(connection.encrypted_refresh_token));
    const messageIds = await listGmailMessageIds(accessToken, "from:(nubank.com.br) newer_than:14d");
    const results = [];
    for (const messageId of messageIds) {
      results.push(await importMessage(connection, accessToken, messageId, options));
    }
    await admin.from("gmail_connections").update({ last_synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("user_id", connection.user_id);
    return results;
  } catch (error) {
    await admin.from("gmail_connections").update({ last_error: error instanceof Error ? error.message.slice(0, 500) : "Erro desconhecido", updated_at: new Date().toISOString() }).eq("user_id", connection.user_id);
    throw error;
  }
}

export async function enqueueGmailSync(userId: string, historyId: string, messageId: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("enqueue_gmail_sync", {
    target_user_id: userId,
    incoming_history_id: historyId,
    incoming_message_id: messageId,
  });
  if (error) throw error;
  return data === true;
}

export async function processQueuedGmailSync(userId: string) {
  const admin = createAdminClient();
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await admin
        .from("gmail_connections")
        .select("*")
        .eq("user_id", userId)
        .single();
      if (error) throw error;
      const targetHistoryId = data.pending_history_id as string | null;
      if (!targetHistoryId) break;

      await syncGmailConnection(data as GmailConnection);
      const { data: cleared, error: clearError } = await admin
        .from("gmail_connections")
        .update({
          last_history_id: targetHistoryId,
          pending_history_id: null,
          sync_lock_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId)
        .eq("pending_history_id", targetHistoryId)
        .select("user_id")
        .maybeSingle();
      if (clearError) throw clearError;
      if (cleared) break;
    }
  } finally {
    await admin
      .from("gmail_connections")
      .update({ sync_lock_until: null, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  }
}

export async function renewGmailWatch(connection: GmailConnection) {
  const admin = createAdminClient();
  const accessToken = await getAccessToken(decryptToken(connection.encrypted_refresh_token));
  const watch = await startGmailWatch(accessToken);
  await admin.from("gmail_connections").update({
    watch_expiration: new Date(Number(watch.expiration)).toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq("user_id", connection.user_id);
  await admin.from("gmail_connections").update({
    last_history_id: watch.historyId,
  }).eq("user_id", connection.user_id).is("last_history_id", null);
  return watch;
}
