-- Efeito: guarda a tentativa e o envio único das instruções do link público no WhatsApp Business.
-- Reversão: remova a lógica de envio primeiro; mantenha estas colunas para preservar o histórico de entrega.
alter table public.barber_contas
  add column if not exists site_instrucoes_whatsapp_tentativa_em timestamptz,
  add column if not exists site_instrucoes_whatsapp_enviado_em timestamptz;
