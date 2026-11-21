-- Efeito: adiciona atalhos slash ao menu geral sem apagar o texto personalizado existente.
-- Reversão segura: remove apenas o bloco identificado abaixo, sem alterar catálogo ou contas.

update public.barber_config
   set menu = rtrim(menu) || case
         when menu like '%/menu contabilidade%' then ''
         else E'\n\nAtalhos rápidos:\n  /menu contabilidade — lançamentos, preços e relatórios\n  /menu pagina — editar nome, endereço, horários e dados da página\n  /menu agenda — marcar e cuidar dos horários\n  /menu funcionario — menu do profissional'
       end,
       atualizado_em = now()
 where id = 1;
