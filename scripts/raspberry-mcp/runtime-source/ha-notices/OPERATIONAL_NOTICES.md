# Avisos operacionais persistentes

O complemento `operational_notices.cjs` reconhece somente três títulos públicos:
crescimento de armazenamento, projeção de pouca folga do Codex e recuperação
dessa projeção. Título exato e corpo completo revisado produzem apenas códigos
do catálogo `operational_notice_templates.json`; números e texto de origem não
são exportados. Corpo desconhecido ou com sufixo mantém a redação conservadora.

O aviso de armazenamento informa uma solicitação de limpeza. Seu resultado
exige recibo separado. O aviso Codex descreve uma projeção de uso, sem comprovar
cota atual no provedor nem conclusão de tarefa. O escopo permanece limitado a
notificações persistentes, sem histórico completo dos pushes do celular.

Categoria, resumo legado, IDs, revisão e contadores de eventos permanecem
iguais. Recarregar o estado atual para enriquecer conteúdo não cria evento novo
e não renova assinatura nem orçamento. O sanitizador e catálogo compartilhados
com Node-RED ficam independentes deste complemento específico do coletor HA.

Implantar o catálogo e o leitor antes do produtor; validar todos os hashes e
dependências. Reiniciar somente o coletor de notificações, uma vez, após fechar
a cadeia. Preservar o cache e recibos. Resultado incerto exige reconciliação,
sem repetir restart, entrega ou aplicação. Os testes exercitam renderização
Python, sufixos privados, contratos antigos e conservação de revisões/eventos.
