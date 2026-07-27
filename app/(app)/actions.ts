"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_COOKIE, getContext } from "@/lib/profiles";
import { parseBRL } from "@/lib/format";
import { decodeCsvBytes, parseTransactionsCsv } from "@/lib/csv";
import { GOOGLE_SCOPES } from "@/lib/gmail/oauth";
import { createAdminClient } from "@/lib/supabase/admin";
import { renewGmailWatch, syncGmailConnection } from "@/lib/gmail/sync";
import type { GmailConnection } from "@/lib/gmail/google";
import { addMonthsToDate, allocateInstallmentShares, splitInstallments } from "@/lib/transactions";

type AppSupabase = Awaited<ReturnType<typeof createClient>>;
const TRANSACTION_TYPES = ["expense", "income", "transfer_out", "transfer_in", "card_payment"] as const;
type SplitConfig = { userId: string; percentage: number };

function transactionType(value: FormDataEntryValue | null) {
  const type = String(value ?? "expense");
  return TRANSACTION_TYPES.includes(type as (typeof TRANSACTION_TYPES)[number]) ? type : "expense";
}

function fail(message: string): never {
  throw new Error(message);
}

function check(error: { message: string } | null, context: string) {
  if (error) fail(`${context}: ${error.message}`);
}

function splitConfig(formData: FormData): SplitConfig[] {
  const raw = String(formData.get("split_config") ?? "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { userId?: unknown; percentage?: unknown }[];
    if (!Array.isArray(parsed)) fail("A divisao informada e invalida.");
    return parsed.map((item) => ({
      userId: String(item.userId ?? ""),
      percentage: Number(item.percentage ?? 0),
    })).filter((item) => item.userId && item.percentage > 0);
  } catch {
    fail("A divisao informada e invalida.");
  }
}

async function requireProfile(profileId: string): Promise<AppSupabase> {
  if (!profileId) fail("Perfil não informado.");
  const { supabase, profiles } = await getContext();
  if (!profiles.some((profile) => profile.id === profileId)) fail("Acesso negado a este perfil.");
  return supabase;
}

async function requireOwnedRow(
  table: "transactions" | "income_sources" | "goals" | "house_products" | "house_costs" | "accounts",
  id: string,
) {
  const { supabase, profiles } = await getContext();
  const { data, error } = await supabase.from(table).select("profile_id").eq("id", id).single();
  check(error, "Não foi possível validar o registro");
  if (!data || !profiles.some((profile) => profile.id === data.profile_id)) fail("Acesso negado ao registro.");
  return supabase;
}

export async function switchProfile(formData: FormData) {
  const id = String(formData.get("profileId") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");
  await requireProfile(id);
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_COOKIE, id, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect(next);
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function addTransaction(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const { userId, profiles } = await getContext();
  const totalAmount = parseBRL(formData.get("amount"));
  if (totalAmount <= 0) fail("Informe um valor maior que zero.");

  const description = String(formData.get("description") ?? "").trim() || null;
  const categoryId = String(formData.get("category_id") ?? "") || null;
  const accountId = String(formData.get("account_id") ?? "") || null;
  const destinationProfileId = String(formData.get("destination_profile_id") ?? "") || null;
  const txnType = transactionType(formData.get("transaction_type"));
  const occurredAt = String(formData.get("occurred_at") ?? "") || new Date().toISOString().slice(0, 10);
  const installmentCount = Math.max(1, Math.min(60, Number(formData.get("installment_count") ?? 1) || 1));
  const splits = splitConfig(formData);
  const sourceProfile = profiles.find((profile) => profile.id === profileId);
  if (!sourceProfile) fail("Perfil de origem nao encontrado.");
  const allocationProfileId = destinationProfileId
    ?? (sourceProfile.context_type === "personal" ? null : profileId);

  if (destinationProfileId && !profiles.some((profile) => profile.id === destinationProfileId)) {
    fail("Voce nao participa do espaco escolhido.");
  }
  if (splits.length && !allocationProfileId) {
    fail("Escolha Casa, empresa ou outro espaco compartilhado para dividir o gasto.");
  }
  if (accountId) {
    const { data: account } = await supabase.from("accounts")
      .select("id").eq("id", accountId).eq("profile_id", profileId).maybeSingle();
    if (!account) fail("A conta escolhida nao pertence ao perfil de origem.");
  }

  const splitTotal = splits.reduce((sum, item) => sum + item.percentage, 0);
  if (splits.some((item) => !Number.isFinite(item.percentage) || item.percentage <= 0 || item.percentage > 100)) {
    fail("Informe percentuais validos para a divisao.");
  }
  if (splitTotal > 100.001) fail("A soma das partes nao pode superar 100%.");
  if (splits.some((item) => item.userId === userId)) fail("Sua parte e calculada automaticamente.");

  if (allocationProfileId && splits.length) {
    const uniqueMembers = [...new Set(splits.map((item) => item.userId))];
    const { data: members } = await supabase.from("profile_members")
      .select("user_id").eq("profile_id", allocationProfileId).in("user_id", uniqueMembers);
    if ((members ?? []).length !== uniqueMembers.length) {
      fail("Uma das pessoas escolhidas nao faz parte do espaco de destino.");
    }
  }

  const groupId = installmentCount > 1 ? crypto.randomUUID() : null;
  const installmentAmounts = splitInstallments(totalAmount, installmentCount);
  const rows = installmentAmounts.map((amount, index) => ({
    profile_id: profileId,
    destination_profile_id: destinationProfileId,
    amount,
    total_purchase_amount: totalAmount,
    installment_group_id: groupId,
    installment_number: index + 1,
    installment_count: installmentCount,
    description,
    category_id: categoryId,
    account_id: accountId,
    transaction_type: txnType,
    occurred_at: addMonthsToDate(occurredAt, index),
    source: "manual",
    paid_by_user_id: userId,
    needs_review: txnType === "expense" && !categoryId,
  }));

  const { data: transactions, error } = await supabase.from("transactions")
    .insert(rows).select("id,installment_number,amount").order("installment_number");
  check(error, "Nao foi possivel salvar o gasto");
  if (!transactions?.length) fail("O lancamento nao foi retornado apos ser salvo.");

  if (allocationProfileId && splits.length) {
    const allocations = allocateInstallmentShares(installmentAmounts, splits);
    const splitRows = allocations.flatMap((allocation) =>
      transactions.map((transaction, index) => ({
        transaction_id: transaction.id,
        profile_id: allocationProfileId,
        debtor_user_id: allocation.userId,
        amount: allocation.amounts[index],
        status: "pending",
      })).filter((row) => row.amount > 0),
    );
    const { error: splitError } = await supabase.from("transaction_splits").insert(splitRows);
    if (splitError) {
      await supabase.from("transactions").delete().in("id", transactions.map((transaction) => transaction.id));
      check(splitError, "Nao foi possivel salvar a divisao do gasto");
    }
  }

  revalidatePath("/dashboard");
  revalidatePath("/extrato");
  revalidatePath("/acertos");
  if (destinationProfileId) revalidatePath("/casa/compras");
  redirect(`/extrato?criado=${installmentCount}`);
}

export async function updateTransaction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await requireOwnedRow("transactions", id);
  const { userId } = await getContext();
  const { data: ownedTransaction, error: ownedError } = await supabase
    .from("transactions").select("profile_id,destination_profile_id,paid_by_user_id").eq("id", id).single();
  check(ownedError, "Não foi possível validar o lançamento");
  if (!ownedTransaction) fail("Lançamento não encontrado.");
  const category_id = String(formData.get("category_id") ?? "") || null;
  const txnType = transactionType(formData.get("transaction_type"));
  const amount = parseBRL(formData.get("amount"));
  if (amount <= 0) fail("Informe um valor maior que zero.");
  const { error } = await supabase
    .from("transactions")
    .update({
      amount,
      description: String(formData.get("description") ?? "").trim() || null,
      category_id,
      transaction_type: txnType,
      occurred_at: String(formData.get("occurred_at") ?? "") || undefined,
      needs_review: txnType === "expense" && !category_id,
    })
    .eq("id", id);
  check(error, "Não foi possível atualizar o lançamento");
  if (String(formData.get("manage_splits") ?? "") === "1") {
    const { error: clearSplitError } = await supabase.from("transaction_splits").delete().eq("transaction_id", id);
    check(clearSplitError, "Não foi possível atualizar a divisão");
    await saveTransactionSplit(
      supabase, id, ownedTransaction.destination_profile_id ?? ownedTransaction.profile_id,
      ownedTransaction.paid_by_user_id ?? userId, amount, formData,
    );
  }
  revalidatePath("/extrato");
  revalidatePath("/dashboard");
  revalidatePath("/acertos");
}

async function saveTransactionSplit(
  supabase: AppSupabase,
  transactionId: string,
  profileId: string,
  payerUserId: string,
  totalAmount: number,
  formData: FormData,
) {
  const debtorUserId = String(formData.get("debtor_user_id") ?? "");
  const splitAmount = parseBRL(formData.get("split_amount"));
  if (!debtorUserId && splitAmount <= 0) return;
  if (!debtorUserId || splitAmount <= 0) fail("Escolha a pessoa e informe quanto ela deve pagar.");
  if (debtorUserId === payerUserId) fail("Escolha outro membro para dividir o gasto.");
  if (splitAmount > totalAmount) fail("A parte da outra pessoa não pode ser maior que o total.");
  const { data: member } = await supabase.from("profile_members")
    .select("user_id").eq("profile_id", profileId).eq("user_id", debtorUserId).maybeSingle();
  if (!member) fail("A pessoa escolhida não faz parte deste espaço.");
  const { error } = await supabase.from("transaction_splits").insert({
    transaction_id: transactionId,
    profile_id: profileId,
    debtor_user_id: debtorUserId,
    amount: splitAmount,
    status: "pending",
  });
  check(error, "Não foi possível dividir o lançamento");
}

export async function markTransactionSplitPaid(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "paid") === "pending" ? "pending" : "paid";
  const { supabase } = await getContext();
  const { error } = await supabase.from("transaction_splits").update({
    status,
    settled_at: status === "paid" ? new Date().toISOString() : null,
  }).eq("id", id);
  check(error, "Não foi possível atualizar o acerto");
  revalidatePath("/extrato");
  revalidatePath("/dashboard");
  revalidatePath("/acertos");
}

export async function deleteTransaction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await requireOwnedRow("transactions", id);
  const { error } = await supabase.from("transactions").delete().eq("id", id);
  check(error, "Não foi possível excluir o lançamento");
  revalidatePath("/extrato");
  revalidatePath("/dashboard");
}

export async function addContribution(formData: FormData) {
  const goal_id = String(formData.get("goal_id") ?? "");
  const amount = parseBRL(formData.get("amount"));
  if (!goal_id || amount <= 0) fail("Informe um aporte maior que zero.");
  const supabase = await requireOwnedRow("goals", goal_id);
  const { error } = await supabase.rpc("fn_add_contribution", { p_goal_id: goal_id, p_amount: amount });
  check(error, "Não foi possível registrar o aporte");

  revalidatePath("/caixinhas");
  revalidatePath("/dashboard");
}

export async function updateIncome(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const amount = parseBRL(formData.get("amount"));
  if (!id) return;
  const supabase = await requireOwnedRow("income_sources", id);
  const { error } = await supabase.from("income_sources").update({ amount }).eq("id", id);
  check(error, "Não foi possível atualizar a renda");
  revalidatePath("/renda");
  revalidatePath("/dashboard");
}

export async function addIncome(formData: FormData) {
  const profile_id = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profile_id);
  const name = String(formData.get("name") ?? "").trim();
  const amount = parseBRL(formData.get("amount"));
  if (!profile_id || !name) return;
  const { error } = await supabase.from("income_sources").insert({ profile_id, name, amount, kind: "salario" });
  check(error, "Não foi possível adicionar a renda");
  revalidatePath("/renda");
  revalidatePath("/dashboard");
}

export async function deleteIncome(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await requireOwnedRow("income_sources", id);
  const { error } = await supabase.from("income_sources").delete().eq("id", id);
  check(error, "Não foi possível remover a renda");
  revalidatePath("/renda");
  revalidatePath("/dashboard");
}

const PROFILE_PRESETS: Record<string, { obrigatoria: number; nao_obrig: number; investimento: number }> = {
  // Tetos de despesa; investimento é o "pague-se primeiro" (pode passar).
  razoavel: { obrigatoria: 0.6, nao_obrig: 0.3, investimento: 0.1 },
  moderado: { obrigatoria: 0.55, nao_obrig: 0.25, investimento: 0.2 },
  investidor: { obrigatoria: 0.5, nao_obrig: 0.2, investimento: 0.3 },
};

async function setBucket(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profile_id: string,
  bucket: string,
  pct: number,
) {
  const { error } = await supabase
    .from("allocation_rules")
    .update({ percentage: pct })
    .eq("profile_id", profile_id)
    .eq("bucket", bucket);
  check(error, "Não foi possível atualizar a regra");
}

export async function setProfileType(formData: FormData) {
  const profile_id = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profile_id);
  const requestedType = String(formData.get("type") ?? "razoavel");
  const type = requestedType in PROFILE_PRESETS ? requestedType : "razoavel";
  const preset = PROFILE_PRESETS[type];
  if (!profile_id) return;
  const { error } = await supabase.from("profiles").update({ profile_type: type }).eq("id", profile_id);
  check(error, "Não foi possível atualizar o perfil");
  await setBucket(supabase, profile_id, "obrigatoria", preset.obrigatoria);
  await setBucket(supabase, profile_id, "nao_obrig", preset.nao_obrig);
  await setBucket(supabase, profile_id, "investimento", preset.investimento);
  revalidatePath("/perfil");
  revalidatePath("/dashboard");
}

export async function updateAllocations(formData: FormData) {
  const profile_id = String(formData.get("profile_id") ?? "");
  if (!profile_id) return;
  const supabase = await requireProfile(profile_id);
  const o = Number(formData.get("obrigatoria") ?? 0) / 100;
  const n = Number(formData.get("nao_obrig") ?? 0) / 100;
  const i = Number(formData.get("investimento") ?? 0) / 100;
  if ([o, n, i].some((value) => !Number.isFinite(value) || value < 0 || value > 1)) fail("Percentuais inválidos.");
  const { error } = await supabase.from("profiles").update({ profile_type: "personalizado" }).eq("id", profile_id);
  check(error, "Não foi possível atualizar o perfil");
  await setBucket(supabase, profile_id, "obrigatoria", o);
  await setBucket(supabase, profile_id, "nao_obrig", n);
  await setBucket(supabase, profile_id, "investimento", i);
  revalidatePath("/perfil");
  revalidatePath("/dashboard");
}

export async function markProductBought(formData: FormData) {
  const id = String(formData.get("product_id") ?? "");
  const real_value = parseBRL(formData.get("real_value"));
  if (!id) return;
  const supabase = await requireOwnedRow("house_products", id);
  const { error } = await supabase
    .from("house_products")
    .update({ status: "comprado", real_value })
    .eq("id", id);
  check(error, "Não foi possível marcar o produto");
  revalidatePath("/casa/compras");
  revalidatePath("/dashboard");
}

export async function toggleBillPaid(formData: FormData) {
  const cost_id = String(formData.get("cost_id") ?? "");
  const profile_id = String(formData.get("profile_id") ?? "");
  const ym = String(formData.get("ym") ?? "");
  const isPaid = String(formData.get("is_paid") ?? "") === "1";
  if (!cost_id || !ym) return;
  const supabase = await requireOwnedRow("house_costs", cost_id);
  await requireProfile(profile_id);
  const { data: cost, error: costError } = await supabase.from("house_costs").select("profile_id").eq("id", cost_id).single();
  check(costError, "Não foi possível validar a conta");
  if (cost?.profile_id !== profile_id) fail("A conta não pertence ao perfil informado.");

  if (isPaid) {
    const { error } = await supabase
      .from("house_bill_payments")
      .delete()
      .eq("cost_id", cost_id)
      .eq("ym", ym);
    check(error, "Não foi possível reabrir a conta");
  } else {
    const { error } = await supabase
      .from("house_bill_payments")
      .insert({ cost_id, profile_id, ym });
    check(error, "Não foi possível marcar a conta como paga");
  }
  revalidatePath("/casa/contas");
}

export async function importTransactionsCsv(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const selected = formData.getAll("files").filter((item): item is File => item instanceof File && item.size > 0);
  const fallback = formData.get("file");
  const files = selected.length > 0 ? selected : fallback instanceof File && fallback.size > 0 ? [fallback] : [];
  if (files.length === 0) fail("Selecione pelo menos um arquivo CSV.");
  if (files.length > 60) fail("Importe no máximo 60 arquivos por vez.");
  if (files.some((file) => file.size > 1024 * 1024)) fail("Cada CSV deve ter no máximo 1 MB.");
  if (files.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) fail("O conjunto de CSVs deve ter no máximo 5 MB.");

  const rows = (await Promise.all(files.map(async (file) =>
    parseTransactionsCsv(decodeCsvBytes(await file.arrayBuffer()), { fileName: file.name }),
  ))).flat();
  if (rows.length > 5000) fail("Importe no máximo 5.000 lançamentos por vez.");

  const [{ data: categories, error: categoryError }, { data: accounts, error: accountError }] = await Promise.all([
    supabase.from("categories").select("id,name"),
    supabase.from("accounts").select("id,name,institution").eq("profile_id", profileId),
  ]);
  check(categoryError, "Não foi possível carregar as categorias");
  check(accountError, "Não foi possível carregar as contas");
  const key = (value: string | null) => value?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() ?? "";
  const categoryMap = new Map((categories ?? []).map((item) => [key(item.name), item.id]));
  const accountMap = new Map((accounts ?? []).map((item) => [key(item.name), item.id]));
  const knownAccounts = [...new Map(rows.filter((row) => row.accountName && row.institution).map((row) => [key(row.accountName), row])).values()];
  for (const row of knownAccounts) {
    if (!row.accountName || accountMap.has(key(row.accountName))) continue;
    const { data, error } = await supabase.from("accounts").insert({
      profile_id: profileId,
      name: row.accountName,
      institution: row.institution,
      kind: row.accountName.includes("Crédito") ? "credito" : row.accountName.includes("Débito") ? "debito" : "conta",
    }).select("id").single();
    check(error, `Não foi possível criar a conta ${row.accountName}`);
    if (!data) throw new Error(`A conta ${row.accountName} foi criada sem retornar um identificador`);
    accountMap.set(key(row.accountName), data.id);
  }
  const payload = rows.map((row) => {
    const categoryName = row.transactionType === "income" ? "Salário / Renda"
      : row.transactionType === "transfer_in" ? "Transferência recebida"
      : row.transactionType === "transfer_out" ? "Transferência enviada"
      : row.transactionType === "card_payment" ? "Pagamento de fatura"
      : row.categoryName;
    const categoryId = categoryMap.get(key(categoryName)) ?? null;
    return {
      profile_id: profileId,
      amount: row.amount,
      description: row.description,
      occurred_at: row.occurredAt,
      category_id: categoryId,
      account_id: accountMap.get(key(row.accountName)) ?? null,
      transaction_type: row.transactionType,
      counterparty: row.counterparty,
      account_label: row.accountName,
      external_id: row.externalId,
      import_fingerprint: row.importFingerprint,
      source: "csv" as const,
      needs_review: row.transactionType === "expense" && !categoryId,
      raw_text: row.rawText,
      metadata: { importer_version: 2, institution: row.institution, signed_amount: row.signedAmount },
    };
  });
  let inserted = 0;
  for (let start = 0; start < payload.length; start += 250) {
    const { data, error } = await supabase.from("transactions")
      .upsert(payload.slice(start, start + 250), { onConflict: "profile_id,import_fingerprint", ignoreDuplicates: true })
      .select("id");
    check(error, "Não foi possível importar o CSV");
    inserted += data?.length ?? 0;
  }
  revalidatePath("/dashboard");
  revalidatePath("/extrato");
  revalidatePath("/contas");
  revalidatePath("/recorrencias");
  redirect(`/extrato?importados=${inserted}&ignorados=${payload.length - inserted}`);
}

export async function updateAccountFinancialSettings(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const supabase = await requireOwnedRow("accounts", id);
  const optionalMoney = (name: string) => {
    const raw = String(formData.get(name) ?? "").trim();
    return raw ? parseBRL(raw) : null;
  };
  const optionalDay = (name: string) => {
    const raw = String(formData.get(name) ?? "").trim();
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 31) fail("Use um dia entre 1 e 31.");
    return value;
  };
  const { error } = await supabase.from("accounts").update({
    current_balance: optionalMoney("current_balance"),
    balance_updated_at: new Date().toISOString(),
    credit_limit: optionalMoney("credit_limit"),
    statement_closing_day: optionalDay("statement_closing_day"),
    due_day: optionalDay("due_day"),
  }).eq("id", id);
  check(error, "Não foi possível atualizar a conta");
  revalidatePath("/contas");
  revalidatePath("/dashboard");
}

export async function addGoal(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const name = String(formData.get("name") ?? "").trim();
  const targetAmount = parseBRL(formData.get("target_amount"));
  if (!name || targetAmount <= 0) fail("Informe o nome e uma meta maior que zero.");
  const deadline = String(formData.get("deadline") ?? "") || null;
  const priority = String(formData.get("priority") ?? "media");
  const kind = String(formData.get("kind") ?? "curto_prazo");
  const weight = priority === "alta" ? 3 : priority === "baixa" ? 1 : 2;
  const { error } = await supabase.from("goals").insert({
    profile_id: profileId,
    name,
    target_amount: targetAmount,
    deadline,
    priority,
    kind,
    weight,
  });
  check(error, "Não foi possível criar a caixinha");
  revalidatePath("/caixinhas");
  revalidatePath("/dashboard");
}

export async function updateGoal(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const supabase = await requireOwnedRow("goals", id);
  const name = String(formData.get("name") ?? "").trim();
  const targetAmount = parseBRL(formData.get("target_amount"));
  if (!name || targetAmount <= 0) fail("Dados inválidos para a caixinha.");
  const priority = String(formData.get("priority") ?? "media");
  const { error } = await supabase.from("goals").update({
    name,
    target_amount: targetAmount,
    deadline: String(formData.get("deadline") ?? "") || null,
    priority,
    kind: String(formData.get("kind") ?? "curto_prazo"),
    weight: priority === "alta" ? 3 : priority === "baixa" ? 1 : 2,
    status: String(formData.get("status") ?? "em_andamento"),
  }).eq("id", id);
  check(error, "Não foi possível atualizar a caixinha");
  revalidatePath("/caixinhas");
  revalidatePath("/dashboard");
}

export async function deleteGoal(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const supabase = await requireOwnedRow("goals", id);
  const { error } = await supabase.from("goals").delete().eq("id", id);
  check(error, "Não foi possível excluir a caixinha");
  revalidatePath("/caixinhas");
  revalidatePath("/dashboard");
}

export async function addHouseProduct(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) fail("Informe o nome do produto.");
  const { error } = await supabase.from("house_products").insert({
    profile_id: profileId,
    name,
    category: String(formData.get("category") ?? "").trim() || null,
    planned_month: String(formData.get("planned_month") ?? "") || null,
    priority: Number(formData.get("priority") ?? 0) || null,
    budget_base: parseBRL(formData.get("budget_base")) || null,
    ideal_qty: String(formData.get("ideal_qty") ?? "").trim() || null,
  });
  check(error, "Não foi possível adicionar o produto");
  revalidatePath("/casa/compras");
  revalidatePath("/dashboard");
}

export async function deleteHouseProduct(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const supabase = await requireOwnedRow("house_products", id);
  const { error } = await supabase.from("house_products").delete().eq("id", id);
  check(error, "Não foi possível excluir o produto");
  revalidatePath("/casa/compras");
  revalidatePath("/dashboard");
}

export async function addHouseCost(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const name = String(formData.get("name") ?? "").trim();
  const expectedValue = parseBRL(formData.get("expected_value"));
  if (!name || expectedValue <= 0) fail("Informe o nome e um valor maior que zero.");
  const barbaraPct = Number(formData.get("barbara_pct") ?? 63.41) / 100;
  if (!Number.isFinite(barbaraPct) || barbaraPct < 0 || barbaraPct > 1) fail("Rateio inválido.");
  const { error } = await supabase.from("house_costs").insert({
    profile_id: profileId,
    name,
    cost_type: String(formData.get("cost_type") ?? "recorrente"),
    expected_value: expectedValue,
    barbara_pct: barbaraPct,
    gabriel_pct: 1 - barbaraPct,
    buy_when: String(formData.get("buy_when") ?? "").trim() || null,
  });
  check(error, "Não foi possível adicionar o custo");
  revalidatePath("/casa/contas");
  revalidatePath("/dashboard");
}

export async function deleteHouseCost(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const supabase = await requireOwnedRow("house_costs", id);
  const { error } = await supabase.from("house_costs").delete().eq("id", id);
  check(error, "Não foi possível excluir o custo");
  revalidatePath("/casa/contas");
  revalidatePath("/dashboard");
}

export async function changePassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");
  if (password.length < 12) fail("A nova senha deve ter pelo menos 12 caracteres.");
  if (password !== confirmation) fail("As senhas não coincidem.");
  const { supabase } = await getContext();
  const { error } = await supabase.auth.updateUser({ password });
  check(error, "Não foi possível alterar a senha");
  redirect("/perfil?senha=ok");
}

export async function connectGmail() {
  const { supabase, active } = await getContext();
  const headerStore = await headers();
  const forwardedHost = (headerStore.get("x-forwarded-host") ?? headerStore.get("host"))?.split(",")[0]?.trim();
  const forwardedProto = (headerStore.get("x-forwarded-proto") ?? (forwardedHost?.includes("localhost") ? "http" : "https"))
    .split(",")[0]
    .trim();
  const origin = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : headerStore.get("origin") ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.linkIdentity({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent("/perfil?gmail=connected")}&profile=${encodeURIComponent(active?.id ?? "")}`,
      scopes: GOOGLE_SCOPES,
      queryParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    },
  });
  if (error || !data.url) fail(`Não foi possível conectar o Gmail: ${error?.message ?? "URL ausente"}`);
  redirect(data.url);
}

export async function syncGmailNow() {
  const { userId } = await getContext();
  const admin = createAdminClient();
  const { data, error } = await admin.from("gmail_connections").select("*").eq("user_id", userId).single();
  check(error, "Gmail ainda não conectado");
  await renewGmailWatch(data as GmailConnection);
  await syncGmailConnection(data as GmailConnection);
  revalidatePath("/perfil");
  revalidatePath("/extrato");
  revalidatePath("/dashboard");
  redirect("/perfil?gmail=synced");
}

export async function reprocessGmailNow() {
  const { userId } = await getContext();
  const admin = createAdminClient();
  const [{ data: connection, error }, { data: imports }] = await Promise.all([
    admin.from("gmail_connections").select("*").eq("user_id", userId).single(),
    admin.from("email_imports").select("transaction_id").eq("user_id", userId),
  ]);
  check(error, "Gmail ainda não conectado");
  const transactionIds = (imports ?? []).map((item) => item.transaction_id).filter(Boolean) as string[];
  if (transactionIds.length) {
    const { error: deleteTransactionsError } = await admin.from("transactions").delete().in("id", transactionIds);
    check(deleteTransactionsError, "Não foi possível remover os lançamentos antigos");
  }
  const { error: deleteImportsError } = await admin.from("email_imports").delete().eq("user_id", userId);
  check(deleteImportsError, "Não foi possível preparar a releitura dos e-mails");
  await renewGmailWatch(connection as GmailConnection);
  await syncGmailConnection(connection as GmailConnection);
  revalidatePath("/perfil");
  revalidatePath("/extrato");
  revalidatePath("/dashboard");
  redirect("/perfil?gmail=reprocessed");
}

export async function createFinancialSpace(formData: FormData) {
  const { supabase } = await getContext();
  const name = String(formData.get("name") ?? "").trim();
  const contextType = String(formData.get("context_type") ?? "household");
  if (!name) fail("Informe o nome do espaço.");
  const { data, error } = await supabase.rpc("fn_create_profile", {
    p_name: name,
    p_context_type: contextType,
    p_color: String(formData.get("color") ?? "#7c3aed"),
  });
  check(error, "Não foi possível criar o espaço");
  if (data) {
    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_COOKIE, String(data), { path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  revalidatePath("/perfil");
  redirect("/perfil?secao=espacos&espaco=created");
}

export async function inviteProfileMember(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const supabase = await requireProfile(profileId);
  if (!email) fail("Informe o e-mail do novo membro.");
  const { data, error } = await supabase.rpc("fn_invite_profile_member", {
    p_profile_id: profileId,
    p_email: email,
  });
  check(error, "Não foi possível adicionar o membro");
  revalidatePath("/perfil");
  redirect(`/perfil?secao=espacos&membro=${data === "member" ? "member" : "invited"}`);
}

export async function respondProfileInvitation(formData: FormData) {
  const invitationId = String(formData.get("invitation_id") ?? "");
  const accept = String(formData.get("decision") ?? "") === "accept";
  if (!invitationId) fail("Convite não informado.");
  const { supabase } = await getContext();
  const { data, error } = await supabase.rpc("fn_respond_profile_invitation", {
    p_invitation_id: invitationId,
    p_accept: accept,
  });
  check(error, "Não foi possível responder ao convite");
  revalidatePath("/", "layout");
  redirect(`/dashboard?convite=${data}`);
}

export async function addFinancialAccount(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) fail("Informe o nome da conta.");
  const aliases = String(formData.get("email_aliases") ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const { error } = await supabase.from("accounts").insert({
    profile_id: profileId,
    name,
    kind: String(formData.get("kind") ?? "conta"),
    institution: String(formData.get("institution") ?? "").trim() || null,
    ownership: String(formData.get("ownership") ?? "personal"),
    email_aliases: aliases,
  });
  check(error, "Não foi possível adicionar a conta");
  revalidatePath("/perfil");
  redirect("/perfil?secao=espacos&conta=created");
}

export async function saveGmailRoute(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const { userId } = await getContext();
  const supabase = await requireProfile(profileId);
  const isDefault = String(formData.get("is_default") ?? "") === "1";
  const matchLabel = isDefault ? "*" : String(formData.get("match_label") ?? "").trim();
  if (!matchLabel) fail("Informe como a conta aparece no e-mail.");
  if (isDefault) {
    const { error } = await supabase.from("gmail_import_routes").update({ is_default: false }).eq("user_id", userId);
    check(error, "Não foi possível alterar a rota padrão");
  }
  const { error } = await supabase.from("gmail_import_routes").upsert({
    user_id: userId,
    profile_id: profileId,
    account_id: String(formData.get("account_id") ?? "") || null,
    match_label: matchLabel,
    is_default: isDefault,
    priority: Number(formData.get("priority") ?? 100),
    active: true,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,profile_id,match_label" });
  check(error, "Não foi possível salvar a regra de importação");
  revalidatePath("/perfil");
  redirect("/perfil?secao=espacos&rota=saved");
}

export async function deleteGmailRoute(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const { userId, supabase } = await getContext();
  const { error } = await supabase.from("gmail_import_routes").delete().eq("id", id).eq("user_id", userId);
  check(error, "Não foi possível excluir a regra");
  revalidatePath("/perfil");
}

async function requireBusinessProfile(profileId: string): Promise<AppSupabase> {
  const supabase = await requireProfile(profileId);
  const { profiles } = await getContext();
  if (profiles.find((profile) => profile.id === profileId)?.context_type !== "business") fail("Este recurso é exclusivo de espaços empresariais.");
  return supabase;
}

export async function addBusinessClient(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireBusinessProfile(profileId);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) fail("Informe o nome do cliente.");
  const { error } = await supabase.from("business_clients").insert({
    profile_id: profileId, name,
    tax_id: String(formData.get("tax_id") ?? "").trim() || null,
    email: String(formData.get("email") ?? "").trim() || null,
    notes: String(formData.get("notes") ?? "").trim() || null,
  });
  check(error, "Não foi possível cadastrar o cliente");
  revalidatePath("/empresa"); revalidatePath("/empresa/clientes");
}

export async function addBusinessContract(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireBusinessProfile(profileId);
  const clientId = String(formData.get("client_id") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const revenueType = String(formData.get("revenue_type") ?? "recurring");
  if (!clientId || !code || !["implementation", "recurring"].includes(revenueType)) fail("Preencha cliente, identificação e tipo do contrato.");
  const { error } = await supabase.from("business_contracts").insert({
    profile_id: profileId, client_id: clientId, code, revenue_type: revenueType,
    total_amount: parseBRL(formData.get("total_amount")) || null,
    monthly_amount: parseBRL(formData.get("monthly_amount")) || null,
    installment_count: Number(formData.get("installment_count") ?? 0) || null,
    start_date: String(formData.get("start_date") ?? "") || null,
    end_date: String(formData.get("end_date") ?? "") || null,
    notes: String(formData.get("notes") ?? "").trim() || null,
  });
  check(error, "Não foi possível cadastrar o contrato");
  revalidatePath("/empresa"); revalidatePath("/empresa/clientes");
}

export async function addBusinessReceivable(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireBusinessProfile(profileId);
  const clientId = String(formData.get("client_id") ?? "");
  const amount = parseBRL(formData.get("amount"));
  const dueDate = String(formData.get("due_date") ?? "");
  const competence = String(formData.get("competence_month") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  if (!clientId || amount <= 0 || !dueDate || !competence || !description) fail("Preencha cliente, competência, vencimento, descrição e valor.");
  const { error } = await supabase.from("business_receivables").insert({
    profile_id: profileId, client_id: clientId,
    contract_id: String(formData.get("contract_id") ?? "") || null,
    revenue_type: String(formData.get("revenue_type") ?? "recurring"),
    description, competence_month: `${competence.slice(0, 7)}-01`, due_date: dueDate, amount,
    installment_number: Number(formData.get("installment_number") ?? 0) || null,
    installment_count: Number(formData.get("installment_count") ?? 0) || null,
    provider: String(formData.get("provider") ?? "").trim() || null,
  });
  check(error, "Não foi possível criar a conta a receber");
  revalidatePath("/empresa"); revalidatePath("/empresa/clientes");
}

export async function markBusinessReceivablePaid(formData: FormData) {
  const receivableId = String(formData.get("receivable_id") ?? "");
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireBusinessProfile(profileId);
  const { error } = await supabase.rpc("fn_mark_business_receivable_paid", {
    p_receivable_id: receivableId,
    p_paid_at: String(formData.get("paid_at") ?? "") || new Date().toISOString().slice(0, 10),
    p_fee_amount: parseBRL(formData.get("fee_amount")),
    p_tax_amount: parseBRL(formData.get("tax_amount")),
    p_direct_cost_amount: parseBRL(formData.get("direct_cost_amount")),
    p_transaction_id: String(formData.get("transaction_id") ?? "") || null,
  });
  check(error, "Não foi possível confirmar o recebimento");
  revalidatePath("/empresa"); revalidatePath("/empresa/clientes"); revalidatePath("/empresa/caixa"); revalidatePath("/empresa/socios");
}

export async function saveBusinessAllocationPolicy(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireBusinessProfile(profileId);
  const userIds = formData.getAll("partner_user_id").map(String);
  const percentages = userIds.map((id) => Number(formData.get(`partner_percentage_${id}`) ?? 0) / 100);
  const companyPercentage = Number(formData.get("company_percentage") ?? 0) / 100;
  const total = companyPercentage + percentages.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 0.00001) fail("Empresa e sócios precisam somar exatamente 100%.");
  const { error } = await supabase.rpc("fn_save_business_allocation_policy", {
    p_profile_id: profileId,
    p_revenue_type: String(formData.get("revenue_type") ?? "recurring"),
    p_calculation_base: String(formData.get("calculation_base") ?? "gross"),
    p_company_percentage: companyPercentage,
    p_partner_user_ids: userIds,
    p_partner_percentages: percentages,
  });
  check(error, "Não foi possível salvar a regra de distribuição");
  revalidatePath("/empresa"); revalidatePath("/empresa/socios");
}

export async function markBusinessPayablePaid(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const id = String(formData.get("payable_id") ?? "");
  const supabase = await requireBusinessProfile(profileId);
  const { error } = await supabase.from("business_partner_payables").update({
    status: "paid", paid_at: String(formData.get("paid_at") ?? "") || new Date().toISOString().slice(0, 10),
  }).eq("id", id).eq("profile_id", profileId);
  check(error, "Não foi possível confirmar o repasse");
  revalidatePath("/empresa"); revalidatePath("/empresa/socios");
}
export async function markProfileTransactionsReviewed(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const { error } = await supabase.from("transactions")
    .update({ needs_review: false })
    .eq("profile_id", profileId)
    .eq("needs_review", true)
    .eq("status", "confirmed");
  check(error, "Não foi possível confirmar os lançamentos");
  revalidatePath("/dashboard");
  revalidatePath("/extrato");
  const next = formData.get("next") === "/empresa" ? "/empresa" : "/dashboard";
  redirect(`${next}?revisao=ok`);
}

export async function saveProfileUserSettings(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const { userId } = await getContext();
  const enabled = new Set(formData.getAll("dashboard_section").map(String));
  const requestedTheme = String(formData.get("theme") ?? "system");
  const { error } = await supabase.from("profile_user_settings").upsert({
    profile_id: profileId, user_id: userId,
    dashboard_sections: Object.fromEntries(["attention", "upcoming", "planning", "goals", "context"].map((key) => [key, enabled.has(key)])),
    objectives: formData.getAll("objective").map(String).filter(Boolean),
    theme: ["system", "light", "dark"].includes(requestedTheme) ? requestedTheme : "system",
    hide_values: String(formData.get("hide_values") ?? "") === "1", updated_at: new Date().toISOString(),
  }, { onConflict: "profile_id,user_id" });
  check(error, "Nao foi possivel salvar suas preferencias");
  revalidatePath("/", "layout");
  redirect("/mais/configuracoes?salvo=1");
}

export async function addCustomCategory(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const { userId } = await getContext();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) fail("Informe o nome da categoria.");
  const isIncome = String(formData.get("kind") ?? "expense") === "income";
  const { error } = await supabase.from("categories").insert({
    profile_id: profileId, name, bucket: isIncome ? "renda" : String(formData.get("bucket") ?? "nao_obrig"),
    is_income: isIncome, color: String(formData.get("color") ?? "#64748b"), created_by: userId,
  });
  check(error, "Nao foi possivel criar a categoria");
  revalidatePath("/categorias");
}

export async function archiveCustomCategory(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const { error } = await supabase.from("categories").update({ archived: true })
    .eq("id", String(formData.get("id") ?? "")).eq("profile_id", profileId);
  check(error, "Nao foi possivel arquivar a categoria");
  revalidatePath("/categorias");
}

export async function createProfileTransfer(formData: FormData) {
  const sourceId = String(formData.get("source_profile_id") ?? "");
  const destinationId = String(formData.get("destination_profile_id") ?? "");
  if (!sourceId || !destinationId || sourceId === destinationId) fail("Escolha dois espacos diferentes.");
  const supabase = await requireProfile(sourceId);
  await requireProfile(destinationId);
  const amount = parseBRL(formData.get("amount"));
  if (amount <= 0) fail("Informe um valor maior que zero.");
  const occurredAt = String(formData.get("occurred_at") ?? "") || new Date().toISOString().slice(0, 10);
  const description = String(formData.get("description") ?? "Transferencia entre espacos").trim();
  const transferGroupId = crypto.randomUUID();
  const { error } = await supabase.from("transactions").insert([
    { profile_id: sourceId, destination_profile_id: destinationId, amount, description, occurred_at: occurredAt, transaction_type: "transfer_out", source: "manual", transfer_group_id: transferGroupId },
    { profile_id: destinationId, destination_profile_id: sourceId, amount, description, occurred_at: occurredAt, transaction_type: "transfer_in", source: "manual", transfer_group_id: transferGroupId },
  ]);
  check(error, "Nao foi possivel transferir");
  revalidatePath("/dashboard"); revalidatePath("/extrato");
  redirect("/extrato?transferencia=1");
}

export async function addFinancialAsset(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const name = String(formData.get("name") ?? "").trim();
  const currentValue = parseBRL(formData.get("current_value"));
  if (!name || currentValue < 0) fail("Preencha o bem e o valor atual.");
  const { error } = await supabase.from("financial_assets").insert({
    profile_id: profileId, name, asset_type: String(formData.get("asset_type") ?? "other"),
    current_value: currentValue, liability_balance: parseBRL(formData.get("liability_balance")),
    ownership_percentage: Math.max(0.01, Math.min(100, Number(formData.get("ownership_percentage") ?? 100))) / 100,
    notes: String(formData.get("notes") ?? "").trim() || null,
  });
  check(error, "Nao foi possivel cadastrar o patrimonio");
  revalidatePath("/patrimonio");
}

export async function deleteFinancialAsset(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const { error } = await supabase.from("financial_assets").delete()
    .eq("id", String(formData.get("id") ?? "")).eq("profile_id", profileId);
  check(error, "Nao foi possivel remover o item");
  revalidatePath("/patrimonio");
}

export async function joinProfileByCode(formData: FormData) {
  const { supabase } = await getContext();
  const { data, error } = await supabase.rpc("fn_join_profile_by_code", { p_code: String(formData.get("code") ?? "") });
  check(error, "Nao foi possivel entrar no espaco");
  if (data) (await cookies()).set(ACTIVE_COOKIE, String(data), { path: "/", maxAge: 31536000 });
  revalidatePath("/", "layout");
  redirect("/familia?entrou=1");
}

export async function regenerateProfileJoinCode(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const { error } = await supabase.rpc("fn_regenerate_profile_join_code", { p_profile_id: profileId });
  check(error, "Nao foi possivel renovar o codigo");
  revalidatePath("/familia");
}

export async function manageProfileMember(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const { error } = await supabase.rpc("fn_manage_profile_member", {
    p_profile_id: profileId, p_user_id: String(formData.get("user_id") ?? ""),
    p_action: String(formData.get("action_type") ?? "member"),
  });
  check(error, "Nao foi possivel alterar o membro");
  revalidatePath("/familia");
}

export async function saveProfileSplitRules(formData: FormData) {
  const profileId = String(formData.get("profile_id") ?? "");
  const supabase = await requireProfile(profileId);
  const rows = formData.getAll("member_user_id").map(String).map((userId) => ({
    profile_id: profileId, user_id: userId,
    percentage: Number(formData.get(`percentage_${userId}`) ?? 0) / 100, updated_at: new Date().toISOString(),
  }));
  if (Math.abs(rows.reduce((sum, row) => sum + row.percentage, 0) - 1) > 0.0001) fail("A divisao precisa somar 100%.");
  const { error } = await supabase.from("profile_split_rules").upsert(rows, { onConflict: "profile_id,user_id" });
  check(error, "Nao foi possivel salvar a divisao padrao");
  revalidatePath("/familia");
}
