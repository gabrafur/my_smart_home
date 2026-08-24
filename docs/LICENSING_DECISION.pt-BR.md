# Memorando de decisão sobre licença e template

[English](LICENSING_DECISION.md) · [Português](LICENSING_DECISION.pt-BR.md)

Status: decisão do proprietário necessária. Este documento é um inventário
técnico e apoio à decisão, não aconselhamento jurídico.

## Estado atual e contradição

Conforme observado pela API do GitHub em 2026-08-24, o repositório é público, o
GitHub não detecta licença raiz e **Template repository está habilitado**. O
controle de template sugere reutilização, enquanto o repositório não concede
licença geral para o trabalho original. A visibilidade pública permite revisar
o projeto, mas ele não deve ser apresentado como open source nem como ponto de
partida reutilizável até o proprietário escolher os termos.

As licenças de terceiros continuam aplicáveis aos arquivos cobertos. Elas não
concedem licença sobre configuração, flows, scripts, documentação ou
integrações independentes do projeto. O inventário técnico está nos
[avisos de terceiros](../THIRD_PARTY_NOTICES.pt-BR.md) e na
[proveniência de dependências](DEPENDENCY_PROVENANCE.md).

## O que existe no repositório

| Categoria | Caminhos representativos | Tratamento atual |
| --- | --- | --- |
| Trabalho original do projeto | `bootstrap/`, `bindings/`, `demo/`, `modules/`, `restore/`, maior parte de `scripts/`, `.github/`, configuração e documentação | sem licença raiz; aplicam-se as restrições autorais padrão |
| Trabalho original no Home Assistant/Node-RED | YAML/Jinja e dashboards do Home Assistant, `claude_code_chat`, `public_bindings`, flows/settings/tools do Node-RED | sem declaração de licença do projeto |
| Vendorizado Apache-2.0 | `homeassistant/custom_components/alexa_media/` | 39 arquivos upstream idênticos à `v5.15.7`; licença upstream preservada |
| Vendorizado MIT | `hacs/`, `kia_uvo/`, `tuya_vacuum_maps/` em `homeassistant/custom_components/` | HACS tem 2 deltas locais, Kia Uvo tem 10 e Tuya Vacuum Maps não tem deltas; licenças preservadas |
| Vendorizado GPL-3.0-only | `homeassistant/custom_components/localtuya/` | 3 arquivos modificados localmente; código coberto e modificações mantêm as obrigações GPL-3.0-only |
| Dependências e imagens gerenciadas | lockfiles npm, requirements de manifests e imagens Compose fixadas por digest | artefatos resolvidos mantêm termos próprios; locks/digests são proveniência, não relicenciamento |
| Integração externa separada | `moni_mobile` é instalada pelo repositório MIT próprio | o código-fonte não está vendorizado aqui |

A auditoria de 2026-08-24 resolveu todas as tags documentadas e comparou byte a
byte cada arquivo rastreado dos componentes vendorizados. Contagens e nomes dos
deltas locais continuam iguais ao guia de proveniência. A tag do Alexa é
anotada: o objeto de tag é `eef9f9c95645c485b4028cd2dc7154f9493093de`,
enquanto o commit efetivamente extraído é
`5365f875c00692771f17c957a58553f30682b5c3`.

## Opções realistas

### 1. Manter o trabalho original sem licença

- Manter o repositório como implementação de referência/portfólio revisável.
- Desabilitar o template do GitHub e evitar linguagem de instalação/reuso.
- Preservar todos os notices e licenças específicas por caminho.
- Consequência prática: a reutilização externa continua restrita e o projeto
  não é um template open source.

### 2. Licenciar permissivamente o trabalho original

- Selecionar uma licença permissiva para código e configuração próprios, com
  exclusões explícitas para caminhos vendorizados e suas licenças atuais.
- Decidir se a documentação usa os mesmos termos ou uma licença de conteúdo.
- Consequência prática: linguagem de template/reuso passa a ser coerente, mas a
  distribuição mista e o diretório LocalTuya coberto por GPL ainda exigem
  notices claros e revisão de compatibilidade.

### 3. Licenciar o trabalho original com termos recíprocos

- Selecionar uma licença recíproca adequada à distribuição e ao uso hospedado
  pretendidos, sem substituir licenças de terceiros por caminho.
- Decidir separadamente o tratamento da documentação.
- Consequência prática: o reuso pode ser permitido com obrigações de
  compartilhamento; compatibilidade e a fronteira entre configuração
  independente e integrações vendorizadas devem ser revisadas antes da escolha.

### 4. Separar código vendorizado da distribuição pública

- Trocar integrações vendorizadas por um mecanismo determinístico de
  fetch/instalação que preserve versões, hashes, patches e notices; depois
  licenciar somente o conteúdo first-party.
- Consequência prática: a licença raiz fica mais simples de explicar e o
  repositório diminui, mas reprodução, restore offline, disponibilidade
  upstream e aplicação de patches viram novas obrigações de engenharia.
- Esta opção, sozinha, não licencia o trabalho original.

### 5. Usar licenças separadas para código e documentação

- Escolher termos explícitos para código/configuração e outros para texto ou
  diagramas, com tabela de escopo por caminho.
- Consequência prática: as permissões se ajustam a cada artefato, mas
  contribuidores e usuários precisam compreender duas políticas.

## Decisões necessárias do proprietário

1. Quais direitos o leitor receberá: apenas inspeção, cópia, modificação,
   redistribuição, uso comercial ou implantação por template?
2. As integrações vendorizadas ficam no repositório ou serão obtidas num passo
   explícito de setup?
3. Código/configuração e documentação usarão a mesma licença?
4. O template do GitHub continuará habilitado depois da escolha dos termos?
5. Quais termos valerão para pull requests externos?
6. É necessária revisão profissional de compatibilidade para a distribuição
   escolhida, em especial pelo código GPL-3.0-only modificado?

## Política pública interina

Até existir decisão explícita, a documentação descreve o repositório como
**implementação de referência / projeto de portfólio**, não como template
reutilizável. A configuração remota de template foi reportada e não alterada.
Nenhum `LICENSE` raiz foi criado e este memorando não escolhe uma das opções.
