-- Efeito: executa a busca de retornos pós-serviço a cada cinco minutos.
-- Reversão: remova somente o job barber-post-service-feedback; não altere os dados dos agendamentos.
-- Dependência: aplicar após 20261122_barber_pos_servico_feedback.sql e o deploy da action.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  job_id bigint;
begin
  select jobid into job_id
    from cron.job
   where jobname = 'barber-post-service-feedback'
   limit 1;
  if job_id is not null then
    perform cron.unschedule(job_id);
  end if;

  perform cron.schedule(
    'barber-post-service-feedback',
    '*/5 * * * *',
    $cron$
      select net.http_post(
        url := 'https://ggufcvrwctieacvbbwim.supabase.co/functions/v1/peixeiro',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object(
          'action', 'barb_pagamento_cron',
          'token', (select aviso_token from public.greenapi_config where id = 1)
        ),
        timeout_milliseconds := 30000
      );
    $cron$
  );
end;
$$;
