# Configuração recomendada do repositório GitHub

[Português (principal)](GITHUB_REPOSITORY_SETTINGS.md) · [English](GITHUB_REPOSITORY_SETTINGS.en.md)

Este é um checklist operacional, não configuração como código. O estado atual
foi lido pela API do GitHub em 2026-08-24; nenhuma opção remota foi alterada.
Confirme novamente na interface antes de aplicar recomendações.

## Estado observado e recomendado

| Área | Estado observado | Estado recomendado | Motivo |
| --- | --- | --- | --- |
| Template repository | **habilitado**, sem licença raiz detectada | desabilitar enquanto a licença estiver indecidida, ou manter somente após licenciar explicitamente o trabalho reutilizável | o controle atual sugere reutilização que os termos não concedem |
| Proteção/ruleset da `main` | sem proteção e sem ruleset | criar ruleset ativo para `main` | impede force-push e deleção acidentais |
| Pull request obrigatório | não exigido | exigir para colaboradores; manter bypass explícito do proprietário se o workflow pessoal direto continuar | contribuições externas passam por revisão sem alterar o fluxo autorizado do dono |
| Check obrigatório | nenhum | exigir **Canonical public validation** após confirmar o nome exibido num PR | alinha merge com `make validate-public` |
| Histórico linear | não exigido | exigir | simplifica auditoria e restore por commit |
| Force-push/deleção | permitidos pela ausência de regra | bloquear | protege histórico e branch padrão |
| Estratégias de merge | merge commit, squash e rebase habilitados | manter **squash**; desabilitar merge commit; rebase é opcional | reduz combinações e mantém histórico coeso |
| Delete branch on merge | desabilitado | habilitar | remove branches de contribuição já integradas |
| Private vulnerability reporting | habilitado | manter | dá canal privado compatível com `SECURITY.md` |
| Actions | habilitado; todas as actions permitidas; pin por SHA não exigido | permitir GitHub e actions verificadas, ou allowlist mínima; exigir pin por SHA se o plano suportar | reduz risco de supply chain |
| Permissão padrão do workflow | `contents: read`; workflow não aprova PR | manter | aplica menor privilégio |
| Dependabot alerts/security updates | habilitados | manter; avaliar version updates semanais | identifica vulnerabilidades nos locks |
| Secret scanning/push protection | ambos habilitados | manter; avaliar padrões não-provider e validity checks se úteis | complementa os scanners locais |
| Topics | 9 topics coerentes | manter; considerar `self-hosted`, `observability`, `disaster-recovery` | melhora descoberta sem claims falsos |
| Description | preenchida e coerente | manter | descreve stack e caráter event-driven |
| Homepage | vazia | opcional: documentação publicada, se existir | não inventar site inexistente |
| Social preview | não verificado via API | enviar `docs/assets/github-social-preview.png` | identidade visual sintética e legível |
| Releases | sem política documentada | usar somente para snapshots restauráveis ou mudanças relevantes | não criar cadência artificial |
| Wiki | habilitada | desabilitar | documentação versionada em `docs/` é a fonte de verdade |
| Projects | habilitado | desabilitar enquanto não houver uso público | reduz superfícies vazias |
| Discussions | desabilitado | manter até existir comunidade/rotina de moderação | evita canal sem manutenção |
| Issues | habilitado | manter | templates sanitizados orientam reports |

## Ruleset sugerido para `main`

1. Target: default branch, enforcement **Active**.
2. Bloquear deleção e force-push; exigir histórico linear.
3. Exigir pull request para participantes externos e pelo menos uma aprovação
   quando houver outro revisor disponível.
4. Exigir resolução de conversas e branch atualizada antes do merge.
5. Exigir o check `Canonical public validation` sem aceitar status antigo.
6. Se o proprietário mantiver push direto, configurar bypass apenas para ele,
   nunca para GitHub Apps genéricos ou todos os administradores.

O bypass é uma decisão operacional explícita, não uma alegação de que a branch
está integralmente protegida. O CI continua rodando em todo push.

## Template versus fork

O controle atual **Use this template** contradiz a ausência de licença raiz.
Até o proprietário concluir a
[decisão de licenciamento](LICENSING_DECISION.pt-BR.md), a posição pública
coerente é implementação de referência/projeto de portfólio, e a configuração
não deve permanecer ativa apenas porque o bootstrap é tecnicamente seguro.
Nenhuma configuração remota foi alterada nesta auditoria.

Um **fork** é apropriado para propor mudanças de volta ao repositório. Preserve
exemplos sintéticos, trabalhe em branch e abra PR conforme
[CONTRIBUTING](../CONTRIBUTING.md). Se o proprietário licenciar a reutilização
e mantiver o template, valide o caminho sem inserir dados reais:

```bash
git clone URL_DO_NOVO_REPOSITORIO smart-home
cd smart-home
make bootstrap-test
make validate-public
make demo
make demo-test
```

`make bootstrap` é o próximo passo deliberado: cria somente templates privados
ausentes e nunca torna o clone uma réplica da residência original.

## Checklist manual na interface

- [ ] Decidir licença raiz e política de template; enquanto estiver indecidida,
  desabilitar **Template repository** para alinhar a interface aos termos.
- [ ] Settings → Rules → criar e ativar o ruleset acima.
- [ ] Settings → General → ajustar merge e **Automatically delete head branches**.
- [ ] Settings → Security → manter private vulnerability reporting, Dependabot
  alerts/security updates, secret scanning e push protection habilitados.
- [ ] Settings → Actions → General → restringir actions e manter permissões de
  workflow somente leitura.
- [ ] About → enviar o social preview, revisar topics, descrição e homepage.
- [ ] Desabilitar Wiki/Projects se continuarem sem uso; manter Discussions off.

Não habilite um required check antes de ele aparecer num pull request, pois um
nome incorreto pode bloquear todos os merges.
