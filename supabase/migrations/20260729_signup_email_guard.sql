-- Prevent duplicate account creation attempts at signup UI level

begin;

create or replace function public.is_registration_email_taken(
  p_email text
)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text;
begin
  v_email := lower(nullif(trim(p_email), ''));

  if v_email is null then
    return false;
  end if;

  return exists (
    select 1
    from auth.users u
    where lower(u.email) = v_email
  );
end;
$$;

grant execute on function public.is_registration_email_taken(text) to anon, authenticated;

commit;
