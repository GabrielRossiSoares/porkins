import Link from "next/link";
import { getContext } from "@/lib/profiles";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  addFinancialAccount,
  changePassword,
  connectGmail,
  createFinancialSpace,
  deleteGmailRoute,
  inviteProfileMember,
  logout,
  reprocessGmailNow,
  saveGmailRoute,
  setProfileType,
  switchProfile,
  syncGmailNow,
  updateAllocations,
} from "../actions";

export const dynamic = "force-dynamic";

type Rule = { bucket: string; percentage: number };
type Account = { id: string; profile_id: string; name: string; kind: string; institution: string | null; ownership: string };
type Route = { id: string; profile_id: string; account_id: string | null; match_label: string; is_default: boolean };
type DirectoryMember = { user_id: string; email: string; display_name: string; role: string };
type PendingInvitation = { id: string; email: string; created_at: string };
type GmailConnectionSummary = {
  gmail_email: string;
  last_synced_at: string | null;
  last_error: string | null;
  watch_expiration: string | null;
};

const TYPES = [
  { key: "razoavel", label: "Razoável", desc: "60 / 30 / 10 — equilíbrio", emoji: "🙂" },
  { key: "moderado", label: "Moderado", desc: "55 / 25 / 20 — investe mais", emoji: "💪" },
  { key: "investidor", label: "Investidor", desc: "50 / 20 / 30 — foco em investir", emoji: "🚀" },
];

const SPACE_LABELS: Record<string, string> = {
  personal: "Pessoal", couple: "Casal", household: "Casa", business: "Empresa", other: "Outro",
};

export default async function Perfil({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { supabase, userId, active, profiles } = await getContext();
  if (!active) return <p className="text-muted">Nenhum perfil.</p>;
  const params = await searchParams;
  const section = params.secao ?? "conta";
  const profileIds = profiles.map((profile) => profile.id);
  const [rulesResult, identityResult, gmailResult, accountsResult, membersResult, routesResult, directoryResult, invitationsResult] = await Promise.all([
    supabase.from("allocation_rules").select("bucket,percentage").eq("profile_id", active.id),
    supabase.auth.getUserIdentities(),
    loadGmailConnection(userId),
    profileIds.length
      ? supabase.from("accounts").select("id,profile_id,name,kind,institution,ownership").in("profile_id", profileIds).eq("active", true).order("name")
      : Promise.resolve({ data: [] }),
    profileIds.length
      ? supabase.from("profile_members").select("profile_id,user_id,role").in("profile_id", profileIds)
      : Promise.resolve({ data: [] }),
    supabase.from("gmail_import_routes").select("id,profile_id,account_id,match_label,is_default").eq("user_id", userId).eq("active", true).order("priority"),
    supabase.rpc("fn_profile_member_directory", { p_profile_id: active.id }),
    supabase.from("profile_invitations").select("id,email,created_at").eq("profile_id", active.id).eq("status", "pending").order("created_at", { ascending: false }),
  ]);
  const rules = (rulesResult.data ?? []) as Rule[];
  const accounts = (accountsResult.data ?? []) as Account[];
  const routes = (routesResult.data ?? []) as Route[];
  const members = membersResult.data ?? [];
  const directory = (directoryResult.data ?? []) as DirectoryMember[];
  const pendingInvitations = (invitationsResult.data ?? []) as PendingInvitation[];
  const gmail = gmailResult;
  const googleIdentity = identityResult.data?.identities.find((identity) => identity.provider === "google");
  const googleEmail = String(googleIdentity?.identity_data?.email ?? gmail?.gmail_email ?? "");
  const pctOf = (bucket: string) => Math.round(Number(rules.find((rule) => rule.bucket === bucket)?.percentage ?? 0) * 100);
  const isShared = active.context_type !== "personal";
  const isBusiness = active.context_type === "business";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs text-muted">Configurações</p>
        <h2 className="text-xl font-bold">Perfil e espaços</h2>
      </div>

      <nav className="grid grid-cols-3 gap-2" aria-label="Seções do perfil">
        <Tab href="/perfil?secao=conta" active={section === "conta"} label="Minha conta" />
        <Tab href="/perfil?secao=espacos" active={section === "espacos"} label="Espaços" />
        <Tab href={isBusiness ? "/empresa" : "/perfil?secao=planejamento"} active={!isBusiness && section === "planejamento"} label={isBusiness ? "Empresa" : "Planejamento"} />
      </nav>

      <Status params={params} />

      {section === "conta" && (
        <>
          <div className="card flex flex-col gap-3">
            <div>
              <p className="font-semibold">Gmail e lançamentos automáticos</p>
              <p className="text-xs text-muted mt-1">
                {googleIdentity ? `Conectado a ${googleEmail}.` : "Conecte o Gmail que recebe notificações bancárias."}
                {gmail?.last_synced_at ? ` Última leitura: ${new Date(gmail.last_synced_at).toLocaleString("pt-BR")}.` : ""}
              </p>
              {gmail?.last_error && <p className="status-danger mt-2" role="alert">Falha recente: {gmail.last_error}</p>}
            </div>
            {!googleIdentity ? (
              <form action={connectGmail}><button className="btn w-full">Conectar Gmail</button></form>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <form action={syncGmailNow}><button className="btn w-full">Sincronizar agora</button></form>
                <form action={reprocessGmailNow}>
                  <button className="btn-warning w-full h-full">Reler últimos 14 dias</button>
                </form>
              </div>
            )}
            <p className="text-[11px] text-muted">A releitura remove somente os lançamentos criados pelo Gmail e os recria com o parser atual. Lançamentos manuais e CSV não são alterados.</p>
          </div>

          <details className="card">
            <summary className="font-semibold cursor-pointer">Segurança da conta</summary>
            <form action={changePassword} className="flex flex-col gap-2 mt-3">
              <input name="password" aria-label="Nova senha" type="password" minLength={12} required autoComplete="new-password" className="input" placeholder="Nova senha (mínimo 12 caracteres)" />
              <input name="confirmation" aria-label="Confirmar nova senha" type="password" minLength={12} required autoComplete="new-password" className="input" placeholder="Confirmar nova senha" />
              <button className="btn">Alterar senha</button>
            </form>
          </details>
          <form action={logout}><button className="btn-danger w-full">Sair da conta</button></form>
        </>
      )}

      {section === "espacos" && (
        <>
          <div className="card">
            <p className="font-semibold">Seus espaços financeiros</p>
            <p className="text-xs text-muted mt-1 mb-3">Separe vida pessoal, casal, casa e empresa. Cada espaço pode ter membros e contas próprias.</p>
            <div className="flex flex-col gap-2">
              {profiles.map((profile) => {
                const count = members.filter((member) => member.profile_id === profile.id).length;
                return (
                  <form action={switchProfile} key={profile.id}>
                    <input type="hidden" name="profileId" value={profile.id} />
                    <input type="hidden" name="next" value="/perfil?secao=espacos" />
                    <button className={`selectable w-full p-3 rounded-xl border flex items-center gap-3 text-left ${profile.id === active.id ? "selectable-active" : ""}`} aria-pressed={profile.id === active.id}>
                      <span className="w-3 h-3 rounded-full" style={{ background: profile.color ?? "#7c3aed" }} />
                      <span className="flex-1 min-w-0">
                        <span className="font-semibold block truncate">{profile.name}</span>
                        <span className="text-xs text-muted">{SPACE_LABELS[profile.context_type]} · {count || 1} membro(s)</span>
                      </span>
                      {profile.id === active.id && <span className="text-brand text-xs font-bold">ATIVO</span>}
                    </button>
                  </form>
                );
              })}
            </div>
          </div>

          <details className="card">
            <summary className="font-semibold cursor-pointer">Criar novo espaço</summary>
            <form action={createFinancialSpace} className="flex flex-col gap-2 mt-3">
              <input name="name" aria-label="Nome do novo espaço" className="input" required maxLength={80} placeholder="Ex.: Casa, Casal, BG Tech" />
              <select name="context_type" aria-label="Tipo do novo espaço" className="input" defaultValue="household">
                <option value="personal">Pessoal</option><option value="couple">Casal</option>
                <option value="household">Casa</option><option value="business">Empresa</option><option value="other">Outro</option>
              </select>
              <label className="text-xs text-muted flex items-center gap-2">Cor <input name="color" type="color" defaultValue="#7c3aed" /></label>
              <button className="btn">Criar espaço</button>
            </form>
          </details>

          {isShared && (
            <div className="card">
              <p className="font-semibold">Membros de {active.name}</p>
              <p className="text-xs text-muted mt-1">A pessoa receberá uma notificação no Porkins para aceitar ou recusar.</p>
              <div className="flex flex-col gap-2 mt-3">
                {directory.map((member) => (
                  <div key={member.user_id} className="surface-muted rounded-xl p-3 flex justify-between gap-3">
                    <div className="min-w-0"><p className="text-sm font-semibold truncate">{member.display_name}</p><p className="text-xs text-muted truncate">{member.email}</p></div>
                    <span className="badge-neutral self-center">{member.role === "owner" ? "Proprietário" : "Membro"}</span>
                  </div>
                ))}
                {pendingInvitations.map((invitation) => (
                  <div key={invitation.id} className="status-warning flex justify-between gap-3">
                    <span className="truncate">{invitation.email}</span><span className="whitespace-nowrap">Aguardando aceite</span>
                  </div>
                ))}
              </div>
              <form action={inviteProfileMember} className="flex gap-2 mt-3">
                <input type="hidden" name="profile_id" value={active.id} />
                <input name="email" aria-label="E-mail do novo membro" type="email" required className="input" placeholder="email@exemplo.com" />
                <button className="btn">Convidar</button>
              </form>
            </div>
          )}

          <div className="card">
            <p className="font-semibold">Contas de {active.name}</p>
            <div className="flex flex-col gap-2 mt-3">
              {accounts.filter((account) => account.profile_id === active.id).map((account) => (
                <div key={account.id} className="surface-muted p-3 rounded-xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3">
                  <span className="text-sm font-semibold text-foreground">{account.name}</span>
                  <span className="text-xs text-muted">{account.institution ?? "Sem banco"} · {account.ownership === "joint" ? "Conjunta" : account.ownership === "business" ? "Empresa" : "Pessoal"}</span>
                </div>
              ))}
              {!accounts.some((account) => account.profile_id === active.id) && <p className="text-xs text-muted">Nenhuma conta cadastrada.</p>}
            </div>
            <details className="mt-3">
              <summary className="text-sm text-brand font-semibold cursor-pointer">+ Adicionar conta</summary>
              <form action={addFinancialAccount} className="grid grid-cols-2 gap-2 mt-3">
                <input type="hidden" name="profile_id" value={active.id} />
                <input name="name" aria-label="Nome da conta" required className="input col-span-2" placeholder="Nome da conta" />
                <input name="institution" aria-label="Instituição financeira" className="input" placeholder="Banco" />
                <select name="kind" aria-label="Tipo da conta" className="input"><option value="conta">Conta</option><option value="debito">Débito</option><option value="credito">Crédito</option><option value="dinheiro">Dinheiro</option></select>
                <select name="ownership" aria-label="Titularidade da conta" className="input col-span-2"><option value="personal">Pessoal</option><option value="joint">Conjunta</option><option value="business">Empresa</option></select>
                <input name="email_aliases" aria-label="Nomes usados nos e-mails bancários" className="input col-span-2" placeholder="Como aparece no e-mail: Nu Empresas, Nubank" />
                <button className="btn col-span-2">Salvar conta</button>
              </form>
            </details>
          </div>

          {googleIdentity && (
            <div className="card">
              <p className="font-semibold">Destino dos e-mails bancários</p>
              <p className="text-xs text-muted mt-1">Crie regras para separar automaticamente conta pessoal, conjunta e empresarial.</p>
              <div className="flex flex-col gap-2 mt-3">
                {routes.map((route) => {
                  const profile = profiles.find((item) => item.id === route.profile_id);
                  const account = accounts.find((item) => item.id === route.account_id);
                  return (
                    <div key={route.id} className="surface-muted p-3 rounded-xl flex items-center justify-between gap-2">
                      <div className="min-w-0"><p className="text-sm font-semibold truncate">{route.is_default ? "Demais e-mails" : route.match_label}</p><p className="text-xs text-muted truncate">→ {profile?.name}{account ? ` · ${account.name}` : ""}</p></div>
                      <form action={deleteGmailRoute}><input type="hidden" name="id" value={route.id} /><button className="text-danger min-h-11 px-2 text-xs font-semibold" aria-label={`Excluir regra ${route.match_label}`}>Excluir</button></form>
                    </div>
                  );
                })}
              </div>
              <details className="mt-3">
                <summary className="text-sm text-brand font-semibold cursor-pointer">+ Nova regra</summary>
                <form action={saveGmailRoute} className="flex flex-col gap-2 mt-3">
                  <input name="match_label" aria-label="Texto que identifica a conta no e-mail" className="input" placeholder="Ex.: Nu Empresas" />
                  <select name="profile_id" aria-label="Espaço de destino" className="input" defaultValue={active.id}>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select>
                  <select name="account_id" aria-label="Conta de destino" className="input" defaultValue=""><option value="">Detectar conta automaticamente</option>{accounts.map((account) => <option key={account.id} value={account.id}>{profiles.find((profile) => profile.id === account.profile_id)?.name} · {account.name}</option>)}</select>
                  <label className="text-xs flex gap-2 items-center"><input type="checkbox" name="is_default" value="1" /> Usar para os demais e-mails</label>
                  <button className="btn">Salvar regra</button>
                </form>
              </details>
            </div>
          )}
        </>
      )}

      {section === "planejamento" && (
        <>
          <Link href="/renda" className="card flex items-center justify-between"><div><p className="font-semibold text-sm">Salário e fontes de renda</p><p className="text-xs text-muted">Valores mensais usados no planejamento</p></div><span className="text-brand font-bold">→</span></Link>
          {isShared ? (
            <div className="card text-sm text-muted">Espaços compartilhados organizam as movimentações de todos os membros. O planejamento percentual individual fica nos espaços pessoais.</div>
          ) : (
            <>
              <div className="card">
                <p className="label mb-2">Estratégia financeira</p>
                <div className="flex flex-col gap-2">{TYPES.map((type) => <form action={setProfileType} key={type.key}><input type="hidden" name="profile_id" value={active.id} /><input type="hidden" name="type" value={type.key} /><button className={`selectable w-full p-3 rounded-xl border text-left flex gap-3 ${active.profile_type === type.key ? "selectable-active" : ""}`} aria-pressed={active.profile_type === type.key}><span className="text-xl" aria-hidden="true">{type.emoji}</span><span><span className="font-semibold text-sm block">{type.label}</span><span className="text-xs text-muted">{type.desc}</span></span></button></form>)}</div>
              </div>
              <div className="card">
                <p className="label mb-2">Ajuste manual dos tetos</p>
                <form action={updateAllocations} className="flex flex-col gap-2"><input type="hidden" name="profile_id" value={active.id} /><FieldPct name="obrigatoria" label="Despesas obrigatórias" value={pctOf("obrigatoria")} /><FieldPct name="nao_obrig" label="Despesas não obrigatórias" value={pctOf("nao_obrig")} /><FieldPct name="investimento" label="Investimentos" value={pctOf("investimento")} /><button className="btn mt-1">Salvar percentuais</button></form>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Tab({ href, active, label }: { href: string; active: boolean; label: string }) {
  return <Link href={href} className={`tab-item ${active ? "tab-item-active" : ""}`} aria-current={active ? "page" : undefined}>{label}</Link>;
}

function Status({ params }: { params: Record<string, string | undefined> }) {
  const message = params.gmail === "connected" ? "Gmail conectado com sucesso."
    : params.gmail === "synced" ? "Gmail sincronizado."
    : params.gmail === "reprocessed" ? "E-mails relidos e lançamentos atualizados."
    : params.espaco === "created" ? "Espaço criado."
    : params.membro === "added" ? "Membro adicionado."
    : params.membro === "member" ? "Esta pessoa já participa do espaço."
    : params.membro === "invited" ? "Convite registrado; o acesso será liberado no primeiro login."
    : params.conta === "created" ? "Conta adicionada."
    : params.rota === "saved" ? "Regra de importação salva."
    : params.senha === "ok" ? "Senha alterada."
    : null;
  return message ? <div className="status-success" role="status">{message}</div> : null;
}

async function loadGmailConnection(userId: string): Promise<GmailConnectionSummary | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("gmail_connections")
      .select("gmail_email,last_synced_at,last_error,watch_expiration")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Não foi possível carregar o estado da integração Gmail no Perfil.", error);
      return null;
    }

    return data as GmailConnectionSummary | null;
  } catch (error) {
    console.error("Integração Gmail indisponível durante a abertura do Perfil.", error);
    return null;
  }
}

function FieldPct({ name, label, value }: { name: string; label: string; value: number }) {
  return <label className="flex items-center justify-between gap-2 text-sm"><span>{label}</span><span className="flex items-center gap-1"><input name={name} type="number" min="0" max="100" defaultValue={value} className="input !w-20 text-right" inputMode="numeric" /><span className="text-muted">%</span></span></label>;
}
