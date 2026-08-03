import Link from "next/link";
import { redirect } from "next/navigation";
import { brl, pct } from "@/lib/format";
import { monthProgress, monthlyGoalNeed, safeToPlan, spendingPace } from "@/lib/financial-insights";
import { getContext } from "@/lib/profiles";

export const dynamic = "force-dynamic";

type Obligation = { status: string; direction: "owe" | "receive"; amount: number };
type Recurrence = { recurrence_key: string; label: string; average_amount: number; expected_next_at: string | null; transaction_type: string };
type FutureTransaction = { id: string; description: string | null; amount: number; occurred_at: string; installment_number: number; installment_count: number };
type Goal = { id: string; name: string; current_amount: number; target_amount: number; deadline: string | null; status: string; progresso: number };
const pad = (value: number) => String(value).padStart(2, "0");
const OBJECTIVE_HINTS: Record<string, { title: string; detail: string; href: string }> = {
  "Diminuir dívidas": { title: "Acompanhar dívidas e acertos", detail: "Veja o que vence e priorize os valores em aberto.", href: "/acertos" },
  "Juntar dinheiro": { title: "Fortalecer suas caixinhas", detail: "Acompanhe o valor necessário para cada meta.", href: "/caixinhas" },
  "Investir": { title: "Manter o aporte do mês", detail: "Compare o que já foi investido com o seu planejamento.", href: "/caixinhas" },
  "Controle financeiro": { title: "Revisar seus lançamentos", detail: "Mantenha categorias e contas organizadas.", href: "/extrato" },
  "Gastar menos": { title: "Observar onde mais saiu dinheiro", detail: "Use o extrato para encontrar gastos que podem ser reduzidos.", href: "/extrato?tipo=gastos" },
  "Equilibrar o orçamento": { title: "Ajustar o planejamento", detail: "Compare os limites com o ritmo atual do mês.", href: "/perfil?secao=planejamento" },
  "Aumentar renda": { title: "Revisar suas fontes de renda", detail: "Atualize salário, extras e receitas previstas.", href: "/renda" },
};

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ convite?: string; revisao?: string }> }) {
  const { supabase, active, userId } = await getContext();
  if (!active) return <p className="text-muted">Nenhum perfil encontrado.</p>;
  if (active.context_type === "business") redirect("/empresa");
  const params = await searchParams;
  const { data: userSettings } = await supabase.from("profile_user_settings").select("dashboard_sections,objectives").eq("profile_id", active.id).eq("user_id", userId).maybeSingle();
  const dashboard = (userSettings?.dashboard_sections ?? { attention: true, upcoming: true, planning: true, goals: true, context: true }) as Record<string, boolean>;
  const selectedObjectives = (userSettings?.objectives ?? []) as string[];
  const objectiveHint = selectedObjectives.map((objective) => OBJECTIVE_HINTS[objective]).find(Boolean);
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const firstOfMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const firstPreviousMonth = `${previousMonthDate.getFullYear()}-${pad(previousMonthDate.getMonth() + 1)}-01`;
  const horizonDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30);
  const horizon = `${horizonDate.getFullYear()}-${pad(horizonDate.getMonth() + 1)}-${pad(horizonDate.getDate())}`;
  const isPersonal = active.context_type === "personal";
  const isHouse = active.context_type === "household";

  const [{ data: incomes }, { data: spending }, { data: goals }, { data: obligations }, { data: recurring }, { data: accountFlow }, { data: reviewRows }, { data: futureRows }, { data: previousRows }, { data: contributions }] = await Promise.all([
    supabase.from("income_sources").select("amount").eq("profile_id", active.id).eq("active", true),
    supabase.from("v_bucket_spending_current").select("bucket,total").eq("profile_id", active.id),
    supabase.from("v_goal_progress").select("id,name,current_amount,target_amount,deadline,status,progresso").eq("profile_id", active.id).order("weight", { ascending: false }),
    supabase.rpc("fn_profile_obligations"),
    supabase.from("v_recurring_candidates").select("recurrence_key,label,average_amount,expected_next_at,transaction_type").eq("profile_id", active.id).gte("expected_next_at", today).lte("expected_next_at", horizon).order("expected_next_at"),
    supabase.from("v_account_monthly_flow").select("income,expenses,transfers_in,transfers_out,card_payments").eq("profile_id", active.id).eq("month", firstOfMonth),
    supabase.from("transactions").select("id,amount").eq("profile_id", active.id).eq("needs_review", true).eq("status", "confirmed"),
    supabase.from("transactions").select("id,description,amount,occurred_at,installment_number,installment_count").eq("profile_id", active.id).eq("status", "confirmed").eq("transaction_type", "expense").gt("installment_count", 1).gte("occurred_at", today).lte("occurred_at", horizon).order("occurred_at"),
    supabase.from("transactions").select("amount").eq("profile_id", active.id).eq("status", "confirmed").eq("transaction_type", "expense").gte("occurred_at", firstPreviousMonth).lt("occurred_at", firstOfMonth),
    supabase.from("contributions").select("amount").eq("profile_id", active.id).gte("contributed_at", firstOfMonth),
  ]);

  const plannedIncome = (incomes ?? []).reduce((sum, item) => sum + Number(item.amount), 0);
  const currentIncome = (accountFlow ?? []).reduce((sum, item) => sum + Number(item.income), 0);
  const income = Math.max(plannedIncome, currentIncome);
  const spent = (spending ?? []).reduce((sum, item) => sum + Number(item.total), 0);
  const previousSpent = (previousRows ?? []).reduce((sum, item) => sum + Number(item.amount), 0);
  const activeGoals = ((goals ?? []) as Goal[]).filter((goal) => goal.status !== "concluida");
  const saved = activeGoals.reduce((sum, goal) => sum + Number(goal.current_amount), 0);
  const investedMonth = (contributions ?? []).reduce((sum, item) => sum + Number(item.amount), 0);
  const pendingObligations = ((obligations ?? []) as Obligation[]).filter((item) => item.status === "pending");
  const owed = pendingObligations.filter((item) => item.direction === "owe").reduce((sum, item) => sum + Number(item.amount), 0);
  const receivable = pendingObligations.filter((item) => item.direction === "receive").reduce((sum, item) => sum + Number(item.amount), 0);
  const future = (futureRows ?? []) as FutureTransaction[];
  const recurrences = ((recurring ?? []) as Recurrence[]).filter((item) => item.transaction_type === "expense");
  const committed = future.reduce((sum, item) => sum + Number(item.amount), 0) + recurrences.reduce((sum, item) => sum + Number(item.average_amount), 0);
  const free = safeToPlan(income, spent, committed);
  const pace = spendingPace(spent, income, monthProgress(now));
  const reviewCount = reviewRows?.length ?? 0;
  const reviewAmount = (reviewRows ?? []).reduce((sum, item) => sum + Number(item.amount), 0);
  const bucketTotal = (bucket: string) => Number((spending ?? []).find((item) => item.bucket === bucket)?.total ?? 0);
  const ruleRows = isPersonal && income > 0 ? await supabase.from("allocation_rules").select("bucket,percentage").eq("profile_id", active.id) : { data: [] };
  const ruleOf = (bucket: string) => Number((ruleRows.data ?? []).find((item) => item.bucket === bucket)?.percentage ?? 0);

  let houseMonthly = 0;
  let houseBought = 0;
  if (isHouse) {
    const [{ data: costs }, { data: products }] = await Promise.all([
      supabase.from("house_costs").select("expected_value").eq("profile_id", active.id).eq("cost_type", "recorrente"),
      supabase.from("house_products").select("real_value").eq("profile_id", active.id).eq("status", "comprado"),
    ]);
    houseMonthly = (costs ?? []).reduce((sum, item) => sum + Number(item.expected_value ?? 0), 0);
    houseBought = (products ?? []).reduce((sum, item) => sum + Number(item.real_value ?? 0), 0);
  }

  const upcoming = [
    ...future.map((item) => ({ id: item.id, label: item.description ?? "Parcela", date: item.occurred_at, amount: Number(item.amount), detail: `${item.installment_number}/${item.installment_count}` })),
    ...recurrences.map((item) => ({ id: `rec-${item.recurrence_key}`, label: item.label, date: item.expected_next_at ?? horizon, amount: Number(item.average_amount), detail: "estimativa" })),
  ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);

  return <div className="flex flex-col gap-4" data-hide-attention={dashboard.attention === false || undefined} data-hide-upcoming={dashboard.upcoming === false || undefined} data-hide-planning={dashboard.planning === false || undefined} data-hide-goals={dashboard.goals === false || undefined} data-hide-context={dashboard.context === false || undefined}>
    <header><p className="eyebrow">{active.name}</p><h1 className="page-title">Seu dinheiro, sem ruído</h1><p className="text-sm text-muted mt-1">O que aconteceu, o que vem pela frente e o que precisa de você.</p></header>
    {params.convite === "accepted" && <div className="status-success" role="status">Convite aceito. O novo espaço já está disponível.</div>}
    {params.convite === "declined" && <div className="status-success" role="status">Convite recusado.</div>}
    {params.revisao === "ok" && <div className="status-success" role="status">Lançamentos confirmados.</div>}

    <section className="hero-card" aria-labelledby="month-reading">
      <p className="eyebrow" id="month-reading">Leitura do mês</p>
      <div className="flex items-end justify-between gap-4 mt-2"><div><p className="text-sm text-muted">{isPersonal && income > 0 ? "Livre no plano" : "Gasto registrado"}</p><p className="hero-value">{brl(isPersonal && income > 0 ? free : spent)}</p></div><span className={`signal ${pace === "on_track" ? "signal-good" : pace === "unknown" ? "signal-neutral" : "signal-attention"}`}>{paceLabel(pace)}</span></div>
      {income > 0 && <div className="bar mt-4" aria-label={`${pct(spent / income)} da renda utilizada`}><span style={{ width: `${Math.min(100, spent / income * 100)}%` }} /></div>}
      <dl className="metric-strip mt-4"><Metric label={isPersonal ? "Renda prevista" : "Entradas"} value={income} /><Metric label="Saiu" value={spent} /><Metric label="Já comprometido" value={committed} /></dl>
    </section>

    {objectiveHint && <Link href={objectiveHint.href} className="card dashboard-context action-row"><StatusDot tone="neutral" /><span className="flex-1"><span className="eyebrow">Seu foco</span><strong className="block text-sm mt-0.5">{objectiveHint.title}</strong><span className="text-xs text-muted">{objectiveHint.detail}</span></span><span aria-hidden="true" className="text-muted">›</span></Link>}

    <section className="dashboard-attention" aria-labelledby="attention-title"><SectionTitle id="attention-title" title="Precisa de você" detail="Só mostramos o que pede uma decisão." /><div className="action-list mt-2">
      {reviewCount > 0 && <div className="action-row"><StatusDot tone="attention" /><Link href="/extrato?tipo=revisar" className="flex-1 min-w-0"><strong className="block text-sm">{reviewCount} lançamento(s) para revisar</strong><span className="text-xs text-muted">{brl(reviewAmount)} aguardando confirmação individual</span></Link><Link href="/extrato?tipo=revisar" className="quiet-action">Revisar</Link></div>}
      {owed > 0 && <ActionRow href="/acertos" tone="attention" title={`Você tem ${brl(owed)} a acertar`} detail="Despesas compartilhadas pendentes" />}
      {receivable > 0 && <ActionRow href="/acertos" tone="good" title={`${brl(receivable)} a receber`} detail="Partes de outras pessoas ainda pendentes" />}
      {committed > 0 && <ActionRow href="/recorrencias" tone="neutral" title={`${brl(committed)} nos próximos 30 dias`} detail={`${future.length} parcela(s) e ${recurrences.length} recorrência(s)`} />}
      {reviewCount === 0 && owed === 0 && receivable === 0 && committed === 0 && <div className="empty-calm"><StatusDot tone="good" /><div><strong className="text-sm">Tudo em ordem</strong><p className="text-xs text-muted">Nenhuma pendência financeira agora.</p></div></div>}
    </div></section>

    {upcoming.length > 0 && <details className="card disclosure-card dashboard-upcoming"><summary><span><strong className="block text-sm">Próximos 30 dias</strong><span className="text-xs text-muted">{future.length} parcela(s) e {recurrences.length} recorrência(s)</span></span><span className="summary-value">{brl(committed)}</span></summary><div className="timeline disclosure-content">{upcoming.map((item) => <div className="timeline-row" key={item.id}><time dateTime={item.date} className="timeline-date">{shortDate(item.date)}</time><div className="flex-1 min-w-0"><p className="text-sm font-semibold truncate">{item.label}</p><p className="text-xs text-muted">{item.detail}</p></div><strong className="text-sm whitespace-nowrap">{brl(item.amount)}</strong></div>)}</div><Link href="/recorrencias" className="quiet-action mt-2">Ver recorrências</Link></details>}

    {isPersonal && income > 0 && <details className="card disclosure-card dashboard-planning"><summary><span><strong className="block text-sm">Planejamento do mês</strong><span className="text-xs text-muted">{previousSpent > 0 ? trendLabel(spent, previousSpent) + " em relação ao mês anterior" : "Primeiro mês com histórico"}</span></span><span className="summary-value">{pct(spent / income)}</span></summary><div className="flex flex-col gap-3 disclosure-content"><PlanRow label="Obrigatórias" value={bucketTotal("obrigatoria")} target={income * ruleOf("obrigatoria")} /><PlanRow label="Flexíveis" value={bucketTotal("nao_obrig")} target={income * ruleOf("nao_obrig")} /><PlanRow label="Investimentos" value={investedMonth} target={income * ruleOf("investimento")} reverse /></div><Link href="/perfil?secao=planejamento" className="quiet-action mt-2">Ajustar planejamento</Link></details>}

    {activeGoals.length > 0 && <details className="card disclosure-card dashboard-goals"><summary><span><strong className="block text-sm">Metas em movimento</strong><span className="text-xs text-muted">{activeGoals.length} meta(s) ativa(s)</span></span><span className="summary-value">{brl(saved)}</span></summary><div className="flex flex-col gap-4 disclosure-content">{activeGoals.slice(0, 3).map((goal) => { const need = monthlyGoalNeed(Number(goal.current_amount), Number(goal.target_amount), goal.deadline, now); return <div key={goal.id}><div className="flex justify-between gap-3 text-sm"><strong>{goal.name}</strong><span className="text-muted whitespace-nowrap">{pct(goal.progresso)}</span></div><div className="bar mt-2"><span style={{ width: String(Math.min(100, Number(goal.progresso) * 100)) + "%" }} /></div><p className="text-xs text-muted mt-1">{brl(goal.current_amount)} de {brl(goal.target_amount)}{need ? " · reserve " + brl(need) + "/mês para chegar no prazo" : ""}</p></div>; })}</div><Link href="/caixinhas" className="quiet-action mt-2">Gerenciar metas</Link></details>}

    {isHouse && <section className="card dashboard-context" aria-labelledby="house-title"><SectionTitle id="house-title" title="Casa" detail="Visão compartilhada sem misturar contas pessoais." action={{ href: "/casa/compras", label: "Abrir" }} /><dl className="metric-strip mt-3"><Metric label="Custo mensal previsto" value={houseMonthly} /><Metric label="Compras realizadas" value={houseBought} /><Metric label="Acertos pendentes" value={owed + receivable} /></dl></section>}
  </div>;
}

function SectionTitle({ id, title, detail, action }: { id: string; title: string; detail: string; action?: { href: string; label: string } }) { return <div className="flex items-start justify-between gap-3"><div><h2 id={id} className="section-title">{title}</h2><p className="text-xs text-muted mt-0.5">{detail}</p></div>{action && <Link href={action.href} className="quiet-action">{action.label}</Link>}</div>; }
function StatusDot({ tone }: { tone: "good" | "attention" | "neutral" }) { return <span className={`status-dot status-dot-${tone}`} aria-hidden="true" />; }
function ActionRow({ href, tone, title, detail }: { href: string; tone: "good" | "attention" | "neutral"; title: string; detail: string }) { return <Link href={href} className="action-row"><StatusDot tone={tone} /><span className="flex-1 min-w-0"><strong className="block text-sm">{title}</strong><span className="text-xs text-muted">{detail}</span></span><span aria-hidden="true" className="text-muted">›</span></Link>; }
function Metric({ label, value }: { label: string; value: number }) { return <div><dt>{label}</dt><dd>{brl(value)}</dd></div>; }
function PlanRow({ label, value, target, reverse }: { label: string; value: number; target: number; reverse?: boolean }) { const ratio = target > 0 ? value / target : 0; const alert = reverse ? value < target : value > target; return <div><div className="flex justify-between gap-3 text-sm"><span>{label}</span><span className={alert ? "text-warning" : "text-muted"}>{brl(value)} / {brl(target)}</span></div><div className="bar mt-1"><span style={{ width: `${Math.min(100, ratio * 100)}%`, background: alert ? "var(--warning)" : "var(--brand-solid)" }} /></div></div>; }
function paceLabel(value: ReturnType<typeof spendingPace>) { return value === "on_track" ? "No ritmo" : value === "attention" ? "Atenção ao ritmo" : value === "over" ? "Acima do plano" : "Sem renda definida"; }
function trendLabel(current: number, previous: number) { const delta = (current - previous) / previous; if (Math.abs(delta) < 0.05) return "praticamente igual"; return `${pct(Math.abs(delta))} ${delta > 0 ? "acima" : "abaixo"}`; }
function shortDate(value: string) { return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", ""); }
