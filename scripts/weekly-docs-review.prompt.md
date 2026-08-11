# Rotina semanal de documentação

Revise profundamente este repositório e mantenha a documentação coerente com
todos os commits e mudanças da última semana.

## Escopo obrigatório

1. Antes de editar, confirme que a branch é `main`, que a árvore está limpa e
   que `origin/main` pode ser integrado somente por fast-forward. Faça
   `git fetch origin main`; se houver divergência, alterações concorrentes ou
   arquivos locais não relacionados, pare sem editar, commitar ou fazer push.
2. Examine os commits desde a revisão documental mais recente e cruze código,
   Compose, Dockerfiles, scripts, configurações e packages com README e `docs/`.
3. Corrija informações incompletas, contraditórias ou obsoletas. Garanta que um
   clone novo consiga construir e configurar a stack usando apenas os arquivos
   públicos mais os segredos privados explicitamente enumerados.
4. Português do Brasil é o idioma principal. Atualize também as versões em
   inglês dos documentos bilíngues e crie um par PT-BR/inglês quando uma nova
   área operacional importante ainda não tiver documentação adequada.
5. Procure credenciais, IPs privados, coordenadas precisas, MACs, identificadores
   físicos, históricos residenciais e outros dados privados. Nunca leia, copie,
   imprima ou versione `.env`, `.local-secrets/`, `secrets.yaml`, `.storage/`,
   bancos, credenciais do Node-RED, dados Matter, Portainer ou Zigbee2MQTT.
6. Consulte somente documentação oficial e atual quando versões, recursos ou
   procedimentos externos puderem ter mudado. Registre referências úteis perto
   das afirmações que elas sustentam.
7. Faça apenas correções mínimas de código/configuração indispensáveis para que
   a documentação seja verdadeira, segura e reproduzível. Não altere o estado
   físico da casa.

## Limites de segurança

- Nunca execute `docker compose config` expandido; use somente `--quiet`.
- Não reinicie nem recrie containers, não recarregue automações e não envie
  notificações ou comandos a dispositivos.
- Não reescreva histórico, não use force-push, não apague estado privado e não
  altere registries do Home Assistant.
- Não reduza scanners, testes ou proteções para fazer uma validação passar.
- Use o lock já adquirido pela rotina e preserve alterações de outros autores.

## Validação e publicação

Execute, no mínimo:

```bash
docker compose config --quiet
docker compose --env-file .env.example config --quiet
node scripts/docs-check.mjs
scripts/security-scan.sh
npm --prefix nodered run flows:validate
npm --prefix nodered run flows:test-alarm-arrival
npm --prefix nodered run flows:test-security
npm --prefix claude-bridge test
git diff --check
```

Use validações adicionais proporcionais às mudanças, sem acionar dispositivos.
Se qualquer verificação falhar, não faça commit nem push e deixe um diagnóstico
claro no log.

Se houver mudanças válidas, crie commits pequenos e descritivos; o commit
documental deve começar com `docs: weekly documentation review`. Rode o scanner
também sobre o conteúdo staged e faça `git push origin main` somente se for
fast-forward. Se a documentação já estiver correta e completa, não crie commit
vazio e não faça push.
