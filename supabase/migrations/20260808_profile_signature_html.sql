begin;

alter table public.profiles
add column if not exists signature_html text
  check (octet_length(signature_html) <= 1048576); -- 1 MB hard limit

drop policy if exists "profiles_select_own_signature" on public.profiles;
create policy "profiles_select_own_signature"
  on public.profiles
  for select
  using (id = auth.uid());

create or replace function public.update_current_profile_signature(
  p_signature_html text
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  update public.profiles
  set signature_html = p_signature_html
  where id = auth.uid();
end;
$$;

grant execute on function public.update_current_profile_signature(text) to authenticated;

commit;
