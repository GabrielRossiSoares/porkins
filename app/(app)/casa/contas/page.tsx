import { getContext } from "@/lib/profiles";
import { brl } from "@/lib/format";
import { addHouseCost, deleteHouseCost, toggleBillPaid } from "../../actions";
import CasaTabs from "../CasaTabs";

export const dynamic = "force-dynamic";

type Cost = {
  id: string;
  cost_type: string;
  name: string;
  expected_value: number | null;
  buy_when: string | null;
};
type Member = { user_id: string; display_name: string; email: string; role: string };
type SplitRule = { user_id: string; percentage: number };
type CostShare = { cost_id: string; user_id: string; percentage: number };

export default async function Contas() {
  const { supabase, profiles, active } = await getContext();
  const casa = active?.context_type === "household"
    ? active
    : profiles.find((profile) => profile.context_type === "household");
  if (!casa) return <p className="text-muted">Espaço Casa não encontrado.</p>;

  const ym = new Date().toISOString().slice(0, 7);
  const mesNome = new Date().toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  const [
    { data: costs, error: costsError },
    { data: pays, error: paysError },
    { data: directory, error: directoryError },
    { data: rules, error: rulesError },
    { data: shares, error: sharesError },
  ] = await Promise.all([
    supabase.from("house_costs").select("id,cost_type,name,expected_value,buy_when").eq("profile_id", casa.id),
    supabase.from("house_bill_payments").select("cost_id").eq("profile_id", casa.id).eq("ym", ym),
    supabase.rpc("fn_profile_member_directory", { p_profile_id: casa.id }),
    supabase.from("profile_split_rules").select("user_id,percentage").eq("profile_id", casa.id),
    supabase.from("house_cost_shares").select("cost_id,user_id,percentage").eq("profile_id", casa.id),
  ]);
  const loadError = costsError ?? paysError ?? directoryError ?? rulesError ?? sharesError;
  if (loadError) {
    return <div className="status-danger" role="alert">Não foi possível carregar as contas da casa: {loadError.message}</div>;
  }

  const members = (directory ?? []) as Member[];
  const splitRules = (rules ?? []) as SplitRule[];
  const costShares = (shares ?? []) as CostShare[];
  const ruleTotal = splitRules.reduce((sum, rule) => sum + Number(rule.percentage), 0);
  const defaultPercentage = (userId: string) => {
    if (Math.abs(ruleTotal - 1) < 0.0001) {
      return Number(splitRules.find((rule) => rule.user_id === userId)?.percentage ?? 0);
    }
    return members.length ? 1 / members.length : 0;
  };
  const percentageFor = (costId: string, userId: string) => {
    const custom = costShares.find((share) => share.cost_id === costId && share.user_id === userId);
    return custom ? Number(custom.percentage) : defaultPercentage(userId);
  };

  const all = (costs ?? []) as Cost[];
  const paidSet = new Set((pays ?? []).map((row) => row.cost_id));
  const recorrentes = all.filter((cost) => cost.cost_type === "recorrente");
  const entrada = all.filter((cost) => cost.cost_type === "entrada");
  const totalMes = recorrentes.reduce((sum, cost) => sum + Number(cost.expected_value ?? 0), 0);
  const totalEntrada = entrada.reduce((sum, cost) => sum + Number(cost.expected_value ?? 0), 0);
  const memberTotals = members.map((member) => ({
    ...member,
    total: recorrentes.reduce(
      (sum, cost) => sum + Number(cost.expected_value ?? 0) * percentageFor(cost.id, member.user_id),
      0,
    ),
  }));
  const pagos = recorrentes.filter((cost) => paidSet.has(cost.id)).length;

  const splitSummary = (cost: Cost) => members
    .map((member) => `${member.display_name}: ${brl(Number(cost.expected_value ?? 0) * percentageFor(cost.id, member.user_id))}`)
    .join(" · ");

  return (
    <div className="flex flex-col gap-4">
      <CasaTabs active="contas" />

      <details className="card">
        <summary className="font-semibold cursor-pointer">Adicionar conta ou custo</summary>
        <form action={addHouseCost} className="flex flex-col gap-3 mt-3">
          <input type="hidden" name="profile_id" value={casa.id} />
          <label className="label">Nome do custo
            <input name="name" required className="input mt-1" placeholder="Ex.: Aluguel" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="label">Tipo
              <select name="cost_type" defaultValue="recorrente" className="input mt-1">
                <option value="recorrente">Conta recorrente</option>
                <option value="entrada">Custo de entrada</option>
              </select>
            </label>
            <label className="label">Valor previsto
              <input name="expected_value" required inputMode="decimal" className="input mt-1" placeholder="R$ 0,00" />
            </label>
          </div>
          <label className="label">Quando comprar ou pagar
            <input name="buy_when" className="input mt-1" placeholder="Opcional" />
          </label>

          <fieldset className="surface-muted rounded-xl p-3">
            <legend className="font-semibold text-sm px-1">Divisão entre os membros</legend>
            <p className="text-xs text-muted mb-2">A sugestão vem da divisão padrão da família e pode ser alterada para este custo.</p>
            <div className="grid gap-2">
              {members.map((member) => (
                <label className="flex items-center gap-3" key={member.user_id}>
                  <input type="hidden" name="member_user_id" value={member.user_id} />
                  <span className="text-sm flex-1">{member.display_name}</span>
                  <input
                    className="input percent-input"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    name={`percentage_${member.user_id}`}
                    defaultValue={Math.round(defaultPercentage(member.user_id) * 10000) / 100}
                    aria-label={`Percentual de ${member.display_name}`}
                    required
                  />
                  <span className="text-muted">%</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button className="btn">Adicionar custo</button>
        </form>
      </details>

      <section className="card">
        <p className="label">Custo mensal previsto</p>
        <p className="text-2xl font-bold" data-money>{brl(totalMes)}</p>
        <p className="text-xs text-muted mt-1">{pagos}/{recorrentes.length} contas pagas em {mesNome}</p>
        <dl className="grid grid-cols-2 gap-2 mt-3">
          {memberTotals.map((member) => (
            <div className="surface-muted rounded-xl p-2" key={member.user_id}>
              <dt className="text-xs text-muted">{member.display_name}</dt>
              <dd className="font-semibold text-sm" data-money>{brl(member.total)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card">
        <h2 className="label mb-2">Contas a pagar do mês</h2>
        <div className="flex flex-col gap-2">
          {!recorrentes.length && <p className="text-sm text-muted">Nenhuma conta recorrente cadastrada.</p>}
          {recorrentes.map((cost) => {
            const paid = paidSet.has(cost.id);
            return (
              <form key={cost.id} action={toggleBillPaid} className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0">
                <input type="hidden" name="cost_id" value={cost.id} />
                <input type="hidden" name="profile_id" value={casa.id} />
                <input type="hidden" name="ym" value={ym} />
                <input type="hidden" name="is_paid" value={paid ? "1" : "0"} />
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${paid ? "line-through text-muted" : ""}`}>{cost.name}</p>
                  <p className="text-xs text-muted">{splitSummary(cost)}</p>
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <span className="text-sm font-semibold" data-money>{brl(cost.expected_value)}</span>
                  <button aria-pressed={paid} aria-label={paid ? `Marcar ${cost.name} como pendente` : `Marcar ${cost.name} como pago`} className={paid ? "px-3 py-1.5 rounded-lg text-sm font-semibold bg-border text-muted" : "btn text-sm"}>
                    {paid ? "Pago ✓" : "Pagar"}
                  </button>
                  <button formAction={deleteHouseCost} name="id" value={cost.id} className="text-danger min-h-11 min-w-11 text-lg" aria-label={`Excluir custo ${cost.name}`}>×</button>
                </div>
              </form>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="flex justify-between items-center mb-2">
          <h2 className="label mb-0">Gastos de entrada</h2>
          <span className="text-sm font-semibold" data-money>{brl(totalEntrada)}</span>
        </div>
        <div className="flex flex-col gap-2">
          {!entrada.length && <p className="text-sm text-muted">Nenhum custo de entrada cadastrado.</p>}
          {entrada.map((cost) => (
            <div key={cost.id} className="flex justify-between text-sm gap-2">
              <div className="min-w-0">
                <p>{cost.name}</p>
                <p className="text-xs text-muted">{cost.buy_when}</p>
                <p className="text-xs text-muted">{splitSummary(cost)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold whitespace-nowrap" data-money>{brl(cost.expected_value)}</span>
                <form action={deleteHouseCost}><button name="id" value={cost.id} className="text-danger min-h-11 min-w-11 text-lg" aria-label={`Excluir custo ${cost.name}`}>×</button></form>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}