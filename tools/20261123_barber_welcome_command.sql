-- Efeito: registra envios administrativos de boas-vindas e impede o comando novo de reenviar
-- para contas que já existiam quando o recurso foi instalado.
-- Reversão: desative o comando e mantenha as colunas para preservar o histórico de envios.
set role peixeiro_2peer;

alter table public.barber_contas
  add column if not exists site_boas_vindas_solicitada_em timestamptz,
  add column if not exists site_boas_vindas_tentativa_em timestamptz,
  add column if not exists site_boas_vindas_enviado_em timestamptz;

update public.barber_contas
   set site_boas_vindas_enviado_em = now()
 where site_boas_vindas_enviado_em is null;
