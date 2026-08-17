# Restauração determinística da casa inteligente

Este prompt coordena uma instalação nova ou uma restauração. A IA organiza o
trabalho; somente os scripts versionados executam validação ou cópia. Nunca
substitua um gate determinístico por uma conclusão textual.

## Segurança absoluta

- Não leia nem imprima credenciais, tokens, chaves, bancos, conteúdo de bundle,
  `.env`, `.local-secrets/`, `secrets.yaml`, `.storage/`, `flows_cred.json`,
  estado Matter/Portainer, `.agent-history/`, `.claude/` ou runtime privado de
  `.codex/`.
- Não inicie, pare, recrie ou consulte containers sem autorização operacional
  específica.
- Não execute `restore-apply` até apresentar plano e verificação e receber uma
  autorização explícita para o destino exato.
- Nunca coloque segredos em argumentos, logs, prompts ou memória pública.
- Pare no primeiro erro de schema, checksum, espaço, compatibilidade, destino,
  owner, grupo, permissões ou dependência.

## 1. Carregar autoridade pública

1. Leia integralmente `AGENTS.md`.
2. Leia `MEMORY.md` e `.codex/memories/projeto/indice.md`.
3. Localize deterministicamente somente as memórias temáticas relevantes a
   restore, privacidade, bindings, segurança e Git.
4. Respeite a ordem: código/configuração, testes, documentação operacional,
   ADRs vigentes e, por último, memória pública.
5. Não consulte históricos privados. Se conhecimento necessário existir apenas
   neles, reporte exatamente `knowledge_not_versioned` sem copiar o conteúdo.

## 2. Identificar o cenário

Classifique explicitamente:

- `fresh_install`: clone público sem bundle anterior;
- `restore`: clone público mais bundle privado externo;
- `context_only`: infraestrutura já restaurada, mas contexto do agente ainda
  não verificado.

Confirme branch/commit e árvore Git sem descartar alterações. O bundle deve
estar fora do repositório e nunca ser movido para uma área rastreável.

## 3. Fresh install

1. Execute `make bootstrap-test`.
2. Apresente os módulos disponíveis com `node scripts/modules-check.mjs`.
3. Se autorizado a criar arquivos privados no clone, execute `make bootstrap`
   ou `node scripts/bootstrap.mjs --modules <lista>`.
4. Não sobrescreva arquivos existentes. Apresente os gaps manuais sem valores.
5. Valide o núcleo com o overlay documentado antes de considerar módulos
   opcionais.

## 4. Restore: planejar e verificar

Com `BACKUP_DIR` apontando para o bundle externo:

1. Execute `make restore-plan BACKUP_DIR=<diretorio>`; não escreva dados.
2. Execute `make restore-verify BACKUP_DIR=<diretorio>`.
3. Apresente somente metadados seguros: schema, commit, arquitetura, contagens,
   checksums válidos, módulos, espaço, serviços a parar, conflitos e ordem.
4. Liste gaps e incompatibilidades. Não tente corrigir o bundle manualmente.

## 5. Autorização antes do apply

Antes de qualquer aplicação, informe:

- destino absoluto resolvido;
- componentes e ordem;
- conflitos existentes;
- serviços que precisam estar parados;
- snapshot/rollback planejado;
- validações pós-restore;
- confirmação adicional exigida para destino não canário.

Solicite autorização explícita. Sem autorização, encerre após o plano.

Quando autorizado, use somente:

```bash
make restore-apply \
  BACKUP_DIR=<diretorio> \
  DESTINATION=<destino> \
  CONFIRM=RESTORE_PRIVATE_STATE
```

Destinos não canários exigem ainda a confirmação adicional documentada no
contrato. Nunca contorne a allowlist nem copie arquivos manualmente.

## 6. Validação e rollback

Após apply autorizado:

1. repita `restore-verify`;
2. valide configuração de forma estática;
3. confirme owners, grupos e permissões sem imprimir conteúdo;
4. execute testes públicos pertinentes;
5. só depois, e com autorização operacional separada, considere iniciar
   serviços;
6. diante de falha, pare e use o snapshot de rollback preparado pela engine.

Não declare sucesso quando houver componente obrigatório ausente ou
incompatibilidade não aprovada.

## 7. Recuperar contexto da IA

Depois de infraestrutura e configuração válidas, execute:

```bash
node scripts/ai-context-recovery.mjs --commit <commit-restaurado>
```

Confirme a cadeia:

```text
infraestrutura restaurada
→ configuração validada
→ commit restaurado identificado
→ AGENTS.md carregado
→ MEMORY.md carregado
→ memórias temáticas relevantes carregadas
→ memória verificada contra o commit
→ agente apto a operar
```

O checker não lê runtime privado e não transforma transcript em memória.

## 8. Relatório final

Informe cenário, commit, bundle verificado, módulos, componentes, ordem,
checksums, compatibilidade, espaço, apply autorizado ou não, resultado,
rollback, validação pós-restore, estado do contexto da IA e gaps. Nunca inclua
valores privados.
