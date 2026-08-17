# Revisão semanal do repositório público

<!-- CODEX_UNATTENDED_WEEKLY_DOCS_REVIEW -->

Esta é uma execução agendada, pré-autorizada e não interativa. Execute esta
rotina imediatamente, sem sugerir título, reescrever o prompt, recomendar modelo
ou solicitar `continue`. Siga todos os limites de segurança e requisitos abaixo.

Revise a documentação, a apresentação pública, o contrato de restauração e as
garantias de privacidade do repositório, mantendo tudo coerente com as mudanças
da última semana.

Esta rotina é de manutenção conservadora. Ela não deve realizar refatorações,
migrações, alterações de runtime ou correções executáveis diretamente em
`main`.

# Pré-condições

1. Leia:
   - `AGENTS.md`;
   - `MEMORY.md`;
   - `docs/PRIVACY_MODEL.md`;
   - `docs/PUBLIC_PRIVATE_BOUNDARY.md`;
   - `docs/RESTORE_CONTRACT.md`;
   - `restore/private-state-manifest.yaml`;
   - `docs/i18n-manifest.json`;
   - `docs/DEPENDENCY_PROVENANCE.md`;
   - `docs/GITHUB_REPOSITORY_SETTINGS.md`.

2. Use o lock já adquirido pelo scheduler.

3. Confirme:

   ```bash
   git branch --show-current
   git status --short
   git fetch origin main
   git rev-list --left-right --count main...origin/main
   ```

4. A branch deve ser `main`, a árvore deve estar limpa e o remoto deve poder
   ser integrado somente por fast-forward.

5. Se houver divergência, commits locais inesperados, alterações concorrentes,
   arquivos não relacionados ou falha de autenticação, pare sem editar,
   commitar ou fazer push.

6. Se `make validate-public` ou os contratos estruturais esperados não
   existirem, registre `baseline_not_installed` e pare. Não volte para uma lista
   parcial e obsoleta de validações.

# Escopo da revisão

Examine os commits desde a última revisão semanal bem-sucedida e cruze:

- código;
- Compose;
- Dockerfiles;
- scripts;
- packages;
- flows;
- testes;
- workflows;
- manifests;
- README;
- documentação;
- arquitetura;
- assets;
- material de portfólio;
- proveniência de terceiros;
- contrato de backup/restauração.

Verifique se as mudanças da semana alteraram:

- arquitetura;
- serviços;
- portas;
- volumes;
- variáveis;
- versões;
- dependências;
- requisitos;
- comandos;
- testes;
- comportamento;
- riscos;
- recovery;
- observabilidade;
- configuração de template;
- instruções para novos usuários;
- afirmações de portfólio;
- fronteira público/privado.

# Documentação humana

Português do Brasil permanece como idioma principal.

Mantenha paridade completa com o inglês conforme
`docs/i18n-manifest.json`.

Atualize os dois idiomas na mesma mudança.

Não crie uma tradução parcial apenas para satisfazer o checker.

Garanta que:

- um novo usuário saiba por onde começar;
- um recrutador entenda rapidamente o valor técnico;
- um contribuidor encontre arquitetura, testes e padrões;
- um operador encontre instalação, restore e troubleshooting;
- um agente encontre contratos claros sem depender de conhecimento implícito.

Verifique links, imagens, diagramas, comandos, nomes de arquivos e exemplos.

# Restauração e reprodutibilidade

Compare qualquer mudança de estado persistente, volume, integração ou serviço
com:

- `restore/private-state-manifest.yaml`;
- o contrato de restauração;
- os scripts de backup e restore;
- os testes de restauração;
- o prompt de restauração para a IA.

Se um novo estado privado for necessário, a documentação, o exemplo, o
manifesto e os testes devem ser atualizados juntos.

Nunca leia o conteúdo real de backups ou arquivos privados.

# Portfólio

Verifique se README e documentos de portfólio continuam:

- tecnicamente verdadeiros;
- apoiados por evidências executáveis;
- sem números não comprovados;
- sem claims de produção não sustentados;
- coerentes com a arquitetura atual;
- com screenshots e assets exclusivamente sintéticos;
- com links funcionando;
- com versões equivalentes em português e inglês.

Atualize diagramas e assets somente por processo reproduzível.

# Privacidade e segurança

Nunca leia, copie, imprima ou versione:

- `.env`;
- `.local-secrets/`;
- `secrets.yaml`;
- `.storage/`;
- bancos;
- credenciais Node-RED;
- estado Zigbee2MQTT;
- Matter;
- Portainer;
- backups;
- denylist privado.

Procure na árvore rastreada e nas mudanças da semana:

- nomes e identificadores pessoais;
- entity IDs ou notificadores específicos;
- coordenadas;
- endereços;
- MACs;
- IPs privados;
- hostnames privados;
- IDs físicos;
- rotinas residenciais;
- datas e horários de eventos privados;
- trajetos;
- logs e payloads reais;
- screenshots não sintéticos;
- metadados de imagem;
- segredos ou tokens.

Não imprima valores encontrados.

Se houver qualquer achado de privacidade ou segurança:

1. não faça commit;
2. não faça push;
3. registre categoria, caminho, linha ou commit de forma mascarada;
4. encerre com resultado `privacy_blocker`.

Não reescreva histórico e não use force-push.

# Limites de alteração

Esta rotina pode alterar automaticamente somente:

- Markdown;
- índices documentais;
- manifests exclusivamente documentais;
- diagramas e imagens gerados;
- material de portfólio;
- links;
- exemplos não executáveis;
- metadados públicos do projeto armazenados no repositório.

Ela não pode alterar automaticamente em `main`:

- código;
- scripts executáveis;
- Compose;
- Dockerfiles;
- workflows;
- packages;
- flows;
- configurações do Home Assistant;
- configurações Node-RED;
- testes;
- scanners;
- dependências;
- manifests operacionais;
- arquivos de restore executáveis.

Se a documentação só puder ser corrigida por uma alteração executável, pare com:

```text
implementation_change_required
```

Deixe um diagnóstico claro com:

- arquivo afetado;
- contradição encontrada;
- correção proposta;
- validações necessárias;
- sugestão de branch.

Não aplique essa correção diretamente.

# Fontes externas

Consulte somente documentação oficial e atual quando versões, recursos,
licenças ou procedimentos externos puderem ter mudado.

Use referências próximas às afirmações relevantes.

Não atualize versões ou procedimentos apenas com base em memória do modelo.

# Validação

Execute:

```bash
make validate-public
make restore-test
scripts/security-scan.sh
make privacy-check
git diff --check
```

Se houver alterações válidas, execute também:

```bash
scripts/security-scan.sh --staged
make privacy-check-staged
git diff --cached --check
```

As validações não podem:

- iniciar ou recriar containers residenciais;
- recarregar automações;
- chamar endpoints reais;
- enviar notificações;
- acionar dispositivos;
- movimentar portão;
- alterar alarmes;
- controlar o veículo;
- modificar registries;
- ler segredos.

Se qualquer validação falhar, não faça commit nem push.

# Commit e publicação

Somente quando:

- as alterações forem exclusivamente documentais;
- todos os checks passarem;
- a privacidade estiver preservada;
- `origin/main` continuar fast-forward;

crie um único commit com prefixo:

```text
docs: weekly public-repository review
```

Antes do push, faça um novo fetch e confirme novamente o fast-forward.

Faça:

```bash
git push origin main
```

somente quando todas as pré-condições continuarem válidas.

Não crie commit vazio.

Se nada precisar ser alterado, registre `no_changes` e não faça push.

# Resultado esperado no log

Registre somente metadados seguros:

- intervalo de commits analisado;
- quantidade de documentos revisados;
- pares bilíngues verificados;
- assets verificados;
- estado do contrato de restauração;
- resultado dos scanners;
- resultado do `make validate-public`;
- resultado do `make restore-test`;
- arquivos documentais alterados;
- commit criado, quando houver;
- resultado final;
- motivo padronizado em caso de bloqueio.

## Memória versionada dos agentes

Trate a memória de IA versionada como parte da arquitetura e da documentação do projeto, não como informação secundária.

Revise obrigatoriamente:

```text
AGENTS.md
MEMORY.md
.codex/memories/**
```

e qualquer outro diretório ou arquivo versionado que posteriormente passe a ser declarado como memória, contexto persistente, instrução de agente, ADR para agentes ou conhecimento canônico do projeto.

### Autoridade

A ordem de autoridade deve ser:

1. código e configuração executável atual;
2. testes e contratos executáveis;
3. documentação operacional atual;
4. decisões arquiteturais vigentes;
5. memória versionada dos agentes.

A memória nunca deve contradizer as fontes acima.

Quando houver divergência:

* não altere código apenas para tornar a memória verdadeira;
* corrija ou remova a memória obsoleta;
* preserve uma decisão histórica somente quando ela estiver explicitamente marcada como histórica;
* registre a fonte atual que substituiu a informação anterior.

### Coerência da memória

Para cada mudança relevante, verifique se ela altera conhecimento reutilizável sobre:

* arquitetura;
* convenções;
* Git e workflow;
* Home Assistant;
* Node-RED;
* integrações;
* entidades e papéis lógicos;
* segurança;
* privacidade;
* restauração;
* observabilidade;
* testes;
* CI/CD;
* Local AI;
* Codex ou outros agentes;
* limitações conhecidas;
* decisões técnicas;
* procedimentos que um agente futuro precisaria conhecer.

Se alterar, atualize o arquivo temático apropriado em `.codex/memories/`.

Não transforme `MEMORY.md` em um arquivo extenso. Ele deve continuar sendo um índice canônico e conciso apontando para memórias temáticas.

### Qualidade

Remova da memória:

* informações temporárias já encerradas;
* resultados de uma única execução sem valor futuro;
* instruções substituídas;
* versões antigas apresentadas como atuais;
* caminhos ou nomes que deixaram de existir;
* duplicação desnecessária da documentação;
* hipóteses que nunca foram confirmadas;
* conclusões contraditas posteriormente por testes ou investigação.

Preserve:

* decisões arquiteturais;
* invariantes;
* contratos;
* convenções;
* riscos recorrentes;
* razões para comportamentos não óbvios;
* procedimentos de recovery;
* armadilhas confirmadas;
* lições de incidentes que evitem regressões.

### Privacidade das memórias

Aplique às memórias versionadas exatamente a mesma política de privacidade aplicada ao restante do repositório.

Não permita nelas:

* nomes privados de moradores;
* relações familiares desnecessárias;
* endereços;
* coordenadas;
* IPs privados;
* MACs;
* IDs físicos;
* IDs privados de contas;
* horários e trajetos residenciais;
* credenciais;
* tokens;
* logs reais;
* transcripts privados;
* informações que permitam reconstruir rotinas da residência.

Use os mesmos papéis lógicos adotados pelo restante do repositório, como:

```text
resident_primary
resident_secondary
mobile_primary
mobile_secondary
vehicle_primary
garage_gate
exterior_light
security_panel
```

### Memória privada de runtime

Não leia, indexe, copie, resuma, publique ou versione automaticamente conteúdos de runtime privados, incluindo:

```text
.agent-history/
.claude/
.codex/
.local-secrets/
```

ou diretórios equivalentes, exceto quando um arquivo específico estiver explicitamente declarado como público e rastreado pelo Git.

O histórico privado de conversas não é fonte documental para a rotina automática.

Se alguma informação importante existir somente em histórico privado, reporte:

```text
knowledge_not_versioned
```

sem copiar seu conteúdo, indicando que ela deve ser transformada manualmente em uma decisão ou memória pública sanitizada.

### Validação

Crie ou evolua uma validação automatizada para verificar que:

* todos os arquivos apontados por `MEMORY.md` existem;
* não existem memórias temáticas órfãs;
* links internos estão válidos;
* caminhos e comandos referenciados continuam existindo;
* termos privados proibidos não aparecem;
* memória e documentação não possuem contradições mecanicamente detectáveis;
* nenhum diretório privado de runtime está rastreado.

Essa validação deve fazer parte de:

```bash
make validate-public
```

Não copie mensagens arbitrárias que possam conter dados privados.

## Revisão semanal da memória de IA

Além da documentação humana, revise explicitamente a memória versionada dos agentes.

Compare os commits da semana com:

```text
AGENTS.md
MEMORY.md
.codex/memories/**
```

Para cada mudança relevante da semana, pergunte:

1. um agente novo receberia uma informação incorreta lendo a memória atual?
2. surgiu uma decisão reutilizável que ainda não foi registrada?
3. alguma limitação ou workaround deixou de existir?
4. alguma investigação recente invalidou uma conclusão antiga?
5. algum nome, caminho, entidade, script, teste ou comando mencionado foi alterado?
6. alguma memória passou a expor informação que agora é considerada privada?
7. existe informação duplicada que deveria permanecer apenas na documentação canônica?

Atualize somente conhecimento reutilizável e confirmado.

Não registre na memória:

* o resumo de todos os commits da semana;
* detalhes efêmeros;
* logs;
* resultados transitórios;
* autorizações temporárias;
* informações que já estão adequadamente representadas por código ou testes e não precisam de contexto adicional.

Se a memória estiver correta, não altere apenas para gerar atividade.

No relatório semanal, registre:

```text
AI memory reviewed: yes
AI memory files checked: <quantidade>
AI memory files changed: <quantidade>
Stale knowledge removed: <quantidade>
New reusable decisions recorded: <quantidade>
Privacy findings in AI memory: <quantidade>
```
