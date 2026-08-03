import Link from "next/link";
import { redirect } from "next/navigation";
import { brl } from "@/lib/format";
import { getContext } from "@/lib/profiles";
import { EmpresaTabs } from "./EmpresaTabs";

export const dynamic = "force-dynamic";
type Receivable = { id:string; revenue_type:string; description:string; amount:number; due_date:string; paid_at:string|null; status:string; client_id:string };
type Payable = { id:string; amount:number; status:string; user_id:string; due_date:string|null };
type Member = { user_id:string; display_name:string };
type BankEntry = { id:string; amount:number; description:string|null; occurred_at:string };
const pad=(value:number)=>String(value).padStart(2,"0");

export default async function Empresa({ searchParams }: { searchParams: Promise<{ revisao?: string }> }) {
  const { supabase, active } = await getContext();
  if (!active || active.context_type !== "business") redirect("/dashboard");
  const params=await searchParams;
  const now=new Date();
  const today=`${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const firstMonth=`${now.getFullYear()}-${pad(now.getMonth()+1)}-01`;
  const horizonDate=new Date(now.getFullYear(),now.getMonth(),now.getDate()+30);
  const horizon=`${horizonDate.getFullYear()}-${pad(horizonDate.getMonth()+1)}-${pad(horizonDate.getDate())}`;

  const [{data:receivables},{data:payables},{data:clients},{data:contracts},{data:goals},{data:directory},{data:reviews},{data:bankEntries},{data:matches}]=await Promise.all([
    supabase.from("business_receivables").select("id,revenue_type,description,amount,due_date,paid_at,status,client_id").eq("profile_id",active.id).order("due_date"),
    supabase.from("business_partner_payables").select("id,amount,status,user_id,due_date").eq("profile_id",active.id),
    supabase.from("business_clients").select("id,name").eq("profile_id",active.id).eq("active",true),
    supabase.from("business_contracts").select("id,revenue_type,monthly_amount,status,start_date,end_date").eq("profile_id",active.id).eq("status","active"),
    supabase.from("goals").select("current_amount").eq("profile_id",active.id).neq("status","concluida"),
    supabase.rpc("fn_profile_member_directory",{p_profile_id:active.id}),
    supabase.from("transactions").select("id,amount").eq("profile_id",active.id).eq("needs_review",true).eq("status","confirmed"),
    supabase.from("transactions").select("id,amount,description,occurred_at").eq("profile_id",active.id).in("transaction_type",["income","transfer_in"]).eq("status","confirmed").order("occurred_at",{ascending:false}).limit(100),
    supabase.from("business_payment_matches").select("transaction_id").eq("profile_id",active.id),
  ]);
  const rows=(receivables??[]) as Receivable[];
  const obligations=(payables??[]) as Payable[];
  const entries=(bankEntries??[]) as BankEntry[];
  const names=new Map((clients??[]).map(client=>[client.id,client.name]));
  const memberNames=new Map(((directory??[]) as Member[]).map(member=>[member.user_id,member.display_name]));
  const matched=new Set((matches??[]).map(item=>item.transaction_id));
  const unmatched=entries.filter(item=>!matched.has(item.id));
  const overdue=rows.filter(item=>item.status!=="paid"&&item.status!=="cancelled"&&item.due_date<today);
  const nextReceivables=rows.filter(item=>item.status!=="paid"&&item.status!=="cancelled"&&item.due_date>=today&&item.due_date<=horizon);
  const receivedMonth=rows.filter(item=>item.status==="paid"&&item.paid_at&&item.paid_at>=firstMonth).reduce((sum,item)=>sum+Number(item.amount),0);
  const dueNext=nextReceivables.reduce((sum,item)=>sum+Number(item.amount),0);
  const partnerPending=obligations.filter(item=>item.status==="pending").reduce((sum,item)=>sum+Number(item.amount),0);
  const projection=dueNext-partnerPending;
  const reserves=(goals??[]).reduce((sum,item)=>sum+Number(item.current_amount),0);
  const implementation=rows.filter(item=>item.status==="paid"&&item.revenue_type==="implementation").reduce((sum,item)=>sum+Number(item.amount),0);
  const recurringRevenue=rows.filter(item=>item.status==="paid"&&item.revenue_type==="recurring").reduce((sum,item)=>sum+Number(item.amount),0);
  const mrr=(contracts??[]).filter(item=>item.revenue_type==="recurring"&&(!item.start_date||item.start_date<=today)&&(!item.end_date||item.end_date>=today)).reduce((sum,item)=>sum+Number(item.monthly_amount??0),0);
  const reviewCount=reviews?.length??0;
  const reviewAmount=(reviews??[]).reduce((sum,item)=>sum+Number(item.amount),0);

  return <div className="flex flex-col gap-5">
    <header><p className="eyebrow">Espaço empresarial</p><h1 className="page-title">{active.name}, em uma leitura</h1><p className="text-sm text-muted mt-1">Recebimentos, compromissos e decisões operacionais.</p></header>
    <EmpresaTabs active="overview" />
    {params.revisao==="ok"&&<div className="status-success" role="status">Movimentos confirmados.</div>}

    <section className="hero-card" aria-labelledby="cash-projection"><p className="eyebrow" id="cash-projection">Projeção de 30 dias</p><div className="flex items-end justify-between gap-4 mt-2"><div><p className="text-sm text-muted">Entradas previstas menos repasses pendentes</p><p className={`hero-value ${projection<0?"text-danger":""}`}>{brl(projection)}</p></div><span className={`signal ${overdue.length?"signal-attention":"signal-good"}`}>{overdue.length?`${overdue.length} vencido(s)`:"Operação em dia"}</span></div><dl className="metric-strip mt-4"><Metric label="Recebido no mês" value={receivedMonth}/><Metric label="A receber em 30 dias" value={dueNext}/><Metric label="Repasses pendentes" value={partnerPending}/></dl></section>

    <section aria-labelledby="business-actions"><SectionTitle id="business-actions" title="Precisa de você" detail="Pendências que afetam caixa ou qualidade dos dados."/><div className="action-list mt-2">
      {overdue.length>0&&<ActionRow href="/empresa/clientes" tone="attention" title={`${overdue.length} recebimento(s) vencido(s)`} detail={brl(overdue.reduce((sum,item)=>sum+Number(item.amount),0))}/>}
      {unmatched.length>0&&<ActionRow href="/empresa/caixa" tone="attention" title={`${unmatched.length} entrada(s) para conciliar`} detail={`${brl(unmatched.reduce((sum,item)=>sum+Number(item.amount),0))} no extrato bancário`}/>}
      {partnerPending>0&&<ActionRow href="/empresa/socios" tone="neutral" title={`${brl(partnerPending)} para repassar`} detail="Distribuições e pagamentos aos sócios"/>}
      {reviewCount>0&&<div className="action-row"><StatusDot tone="attention"/><Link href="/extrato?tipo=revisar" className="flex-1 min-w-0"><strong className="block text-sm">{reviewCount} movimento(s) para revisar</strong><span className="text-xs text-muted">{brl(reviewAmount)} aguardando revisão individual</span></Link><Link href="/extrato?tipo=revisar" className="quiet-action">Revisar</Link></div>}
      {overdue.length===0&&unmatched.length===0&&partnerPending===0&&reviewCount===0&&<div className="empty-calm"><StatusDot tone="good"/><div><strong className="text-sm">Operação em ordem</strong><p className="text-xs text-muted">Nenhuma pendência financeira agora.</p></div></div>}
    </div></section>

    <section className="card" aria-labelledby="receipts-title"><SectionTitle id="receipts-title" title="Próximos recebimentos" detail="Por vencimento, sem misturar com transferências bancárias." action={{href:"/empresa/clientes",label:"Gerenciar"}}/><div className="timeline mt-3">{nextReceivables.slice(0,6).map(item=><div className="timeline-row" key={item.id}><time className="timeline-date" dateTime={item.due_date}>{shortDate(item.due_date)}</time><div className="flex-1 min-w-0"><p className="text-sm font-semibold truncate">{names.get(item.client_id)??item.description}</p><p className="text-xs text-muted">{item.revenue_type==="implementation"?"Implementação":"Recorrência"}</p></div><strong className="text-sm whitespace-nowrap">{brl(item.amount)}</strong></div>)}{nextReceivables.length===0&&<p className="text-sm text-muted py-3">Nenhum recebimento previsto nos próximos 30 dias.</p>}</div></section>

    <section className="card" aria-labelledby="operation-title"><SectionTitle id="operation-title" title="Operação" detail="Indicadores essenciais, sem poluir a tela."/><dl className="business-grid mt-3"><Metric label="MRR vigente" value={mrr}/><Metric label="Implementações recebidas" value={implementation}/><Metric label="Recorrência recebida" value={recurringRevenue}/><Metric label="Reservas" value={reserves}/></dl></section>

    {obligations.filter(item=>item.status==="pending").length>0&&<section className="card" aria-labelledby="partners-title"><SectionTitle id="partners-title" title="Repasses aos sócios" detail="Gerados após a confirmação dos recebimentos." action={{href:"/empresa/socios",label:"Abrir"}}/><div className="flex flex-col gap-2 mt-3">{obligations.filter(item=>item.status==="pending").slice(0,4).map(item=><div key={item.id} className="flex justify-between text-sm"><span>{memberNames.get(item.user_id)??"Sócio"}</span><strong>{brl(item.amount)}</strong></div>)}</div></section>}
  </div>;
}
function SectionTitle({id,title,detail,action}:{id:string;title:string;detail:string;action?:{href:string;label:string}}){return <div className="flex items-start justify-between gap-3"><div><h2 id={id} className="section-title">{title}</h2><p className="text-xs text-muted mt-0.5">{detail}</p></div>{action&&<Link href={action.href} className="quiet-action">{action.label}</Link>}</div>}
function StatusDot({tone}:{tone:"good"|"attention"|"neutral"}){return <span className={`status-dot status-dot-${tone}`} aria-hidden="true"/>}
function ActionRow({href,tone,title,detail}:{href:string;tone:"good"|"attention"|"neutral";title:string;detail:string}){return <Link href={href} className="action-row"><StatusDot tone={tone}/><span className="flex-1 min-w-0"><strong className="block text-sm">{title}</strong><span className="text-xs text-muted">{detail}</span></span><span aria-hidden="true" className="text-muted">›</span></Link>}
function Metric({label,value}:{label:string;value:number}){return <div><dt>{label}</dt><dd>{brl(value)}</dd></div>}
function shortDate(value:string){return new Date(`${value}T12:00:00`).toLocaleDateString("pt-BR",{day:"2-digit",month:"short"}).replace(".","")}