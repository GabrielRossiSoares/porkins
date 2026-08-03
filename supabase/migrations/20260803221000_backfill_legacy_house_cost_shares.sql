-- Preserva as divisões históricas da tabela antiga ao migrar para o modelo multiusuário.
with member_map as (
  select
    pm.profile_id,
    (array_agg(pm.user_id) filter (
      where lower(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1))) ~ 'gabriel'
    ))[1] as gabriel_user_id,
    (array_agg(pm.user_id) filter (
      where lower(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', split_part(u.email, '@', 1))) ~ 'b.rbara'
    ))[1] as barbara_user_id
  from public.profile_members pm
  join auth.users u on u.id = pm.user_id
  group by pm.profile_id
), legacy_shares as (
  select hc.id as cost_id, hc.profile_id, mm.gabriel_user_id as user_id, hc.gabriel_pct as percentage
  from public.house_costs hc
  join member_map mm on mm.profile_id = hc.profile_id
  where mm.gabriel_user_id is not null and hc.gabriel_pct > 0
  union all
  select hc.id, hc.profile_id, mm.barbara_user_id, hc.barbara_pct
  from public.house_costs hc
  join member_map mm on mm.profile_id = hc.profile_id
  where mm.barbara_user_id is not null and hc.barbara_pct > 0
)
insert into public.house_cost_shares(cost_id, profile_id, user_id, percentage)
select cost_id, profile_id, user_id, percentage from legacy_shares
on conflict (cost_id, user_id) do update
set percentage = excluded.percentage, updated_at = now();

do $$
begin
  if exists (
    select 1
    from public.house_costs hc
    left join (
      select cost_id, sum(percentage) as total
      from public.house_cost_shares
      group by cost_id
    ) shares on shares.cost_id = hc.id
    where hc.gabriel_pct + hc.barbara_pct > 0
      and abs(coalesce(shares.total, 0) - (hc.gabriel_pct + hc.barbara_pct)) > 0.0001
  ) then
    raise exception 'Não foi possível preservar todas as divisões históricas da casa';
  end if;
end;
$$;