-- Efeito: permite uma mensagem diária de bom-dia por barbearia às 8h de Brasília.
-- Reversão segura: não apaga barbearias nem conversas; desative o cron ou apague só a coluna.
set role peixeiro_2peer;

alter table public.barber_contas
  add column if not exists bom_dia_enviado_em timestamptz;

reset role;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  job_id bigint;
begin
  select jobid into job_id
    from cron.job
   where jobname = 'barber-daily-bom-dia'
   limit 1;
  if job_id is not null then
    perform cron.unschedule(job_id);
  end if;

  perform cron.schedule(
    'barber-daily-bom-dia',
    '0 11 * * *',
    $cron$
      select net.http_post(
        url := 'https://ggufcvrwctieacvbbwim.supabase.co/functions/v1/peixeiro',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'action', 'barb_cron',
          'token', (select aviso_token from public.greenapi_config where id = 1)
        ),
        timeout_milliseconds := 30000
      );
    $cron$
  );
end;
$$;
