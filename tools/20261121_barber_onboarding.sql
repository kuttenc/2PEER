-- Efeito: guarda o modelo da equipe e das fotos escolhido no onboarding do salão.
-- Reversão segura: remover estas duas colunas não apaga contas, funcionários ou fotos existentes.
set role peixeiro_2peer;

alter table public.barber_contas
  add column if not exists modelo_equipe text not null default '';

alter table public.barber_contas
  add column if not exists divide_lucro boolean;

reset role;
