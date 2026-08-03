import { getContext } from "@/lib/profiles";
import { inviteProfileMember, joinProfileByCode, manageProfileMember, regenerateProfileJoinCode, saveProfileSplitRules } from "../actions";

type Member = { user_id: string; email: string; display_name: string; role: string };
export default async function FamilyPage({ searchParams }: { searchParams: Promise<{ entrou?: string }> }) {
  const { supabase, active, userId } = await getContext();
  if (!active) return null;
  const params = await searchParams;
  const [{ data: profile }, { data: directory }, { data: rules }] = await Promise.all([
    supabase.from("profiles").select("join_code").eq("id", active.id).single(),
    supabase.rpc("fn_profile_member_directory", { p_profile_id: active.id }),
    supabase.from("profile_split_rules").select("user_id,percentage").eq("profile_id", active.id),
  ]);
  const members = (directory ?? []) as Member[];
  const role = members.find((member) => member.user_id === userId)?.role;
  const isOwner = role === "owner";
  const isAdmin = isOwner || role === "admin";
  const pctFor = (id: string) => Math.round(Number((rules ?? []).find((rule) => rule.user_id === id)?.percentage ?? (1 / Math.max(1, members.length))) * 10000) / 100;
  return <div className="flex flex-col gap-4"><header><p className="eyebrow">Pessoas e acesso</p><h1 className="page-title">Família e membros</h1><p className="text-sm text-muted mt-1">Quem participa, quanto cabe a cada pessoa e o que cada papel pode fazer.</p></header>{params.entrou && <p className="status-success">Você entrou no espaço com sucesso.</p>}
    <section className="card"><h2 className="section-title">Entrar com código</h2><form action={joinProfileByCode} className="flex gap-2 mt-3"><input className="input uppercase" name="code" placeholder="CÓDIGO" required /><button className="btn">Entrar</button></form></section>
    <section className="card"><div className="flex justify-between gap-3"><div><h2 className="section-title">Código de {active.name}</h2><p className="text-xs text-muted mt-1">Compartilhe somente com quem deve participar.</p></div><strong className="join-code">{profile?.join_code}</strong></div>{isOwner && <form action={regenerateProfileJoinCode} className="mt-3"><input type="hidden" name="profile_id" value={active.id} /><button className="btn-secondary w-full">Gerar novo código</button></form>}</section>
    {isOwner && <details className="card disclosure-card"><summary><span><strong className="block text-sm">Convidar por e-mail</strong><small className="text-muted">O convite também aparece dentro do Porkins</small></span></summary><form action={inviteProfileMember} className="disclosure-content flex gap-2"><input type="hidden" name="profile_id" value={active.id} /><input className="input" type="email" name="email" placeholder="pessoa@gmail.com" required /><button className="btn">Convidar</button></form></details>}
    <section className="card"><h2 className="section-title">Membros e permissões</h2><div className="settings-list mt-3">{members.map((member) => <div className="member-row" key={member.user_id}><span><strong className="block text-sm">{member.display_name}</strong><small className="text-muted">{member.email} · {member.role}</small></span>{isOwner && member.user_id !== userId && <form action={manageProfileMember} className="flex gap-1"><input type="hidden" name="profile_id" value={active.id} /><input type="hidden" name="user_id" value={member.user_id} /><select className="input compact-input" name="action_type" defaultValue={member.role}><option value="owner">Proprietário</option><option value="admin">Administrador</option><option value="member">Membro</option><option value="viewer">Somente leitura</option><option value="remove">Remover</option></select><button className="btn-secondary">Aplicar</button></form>}</div>)}</div></section>
    {isAdmin && members.length > 1 && <section className="card"><h2 className="section-title">Divisão padrão</h2><p className="text-xs text-muted mt-1">Sugestão inicial para novas despesas. Você ainda pode alterar em cada compra.</p><form action={saveProfileSplitRules} className="grid gap-3 mt-3"><input type="hidden" name="profile_id" value={active.id} />{members.map((member) => <label className="flex items-center gap-3" key={member.user_id}><input type="hidden" name="member_user_id" value={member.user_id} /><span className="flex-1 text-sm">{member.display_name}</span><input className="input percent-input" type="number" step="0.01" min="0" max="100" name={`percentage_${member.user_id}`} defaultValue={pctFor(member.user_id)} /><span>%</span></label>)}<button className="btn">Salvar divisão</button></form></section>}
  </div>;
}
