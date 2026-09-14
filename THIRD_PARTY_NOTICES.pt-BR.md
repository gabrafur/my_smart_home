# Avisos de terceiros

[Português](THIRD_PARTY_NOTICES.pt-BR.md) · [English](THIRD_PARTY_NOTICES.md)

Este repositório distribui código-fonte de terceiros junto com configuração e
ferramentas próprias. Os avisos abaixo valem somente para o código upstream
identificado; eles não concedem licença para o trabalho original do repositório.

## Integrações vendorizadas do Home Assistant

| Componente | Revisão upstream | Licença | Caminho coberto | Estado local |
| --- | --- | --- | --- | --- |
| Alexa Media Player | `v5.16.0` / `3838e40d86e8438fd16477e76380b490382b64e5` | Apache-2.0 | `homeassistant/custom_components/alexa_media/**` | um guard local do coordenador em `__init__.py`; demais arquivos comparados coincidem com a tag |
| HACS | `2.0.5` / `c0dfd8b44297c3673c21973e2539375a53687a9c` | MIT | `homeassistant/custom_components/hacs/**` | metadata de versão e HA mínimo alterada localmente |
| Kia Uvo / Hyundai Bluelink | `v3.10.1` / `2c602560746318fd001db8fe52347e9398f181ed` | MIT | `homeassistant/custom_components/kia_uvo/**` | modificado; consulte a proveniência |

O texto de cada licença foi preservado como `LICENSE.upstream` no diretório do
componente. Copyright continua com os autores upstream. Nomes e marcas são
usados somente para identificar dependências.

Origens, método de comparação, modificações, atualização, dependências
gerenciadas e deveres de atribuição estão no guia de
[proveniência](docs/DEPENDENCY_PROVENANCE.md).

## Runtime Local AI externo

O runtime opcional [`local-ai-rtx`](https://github.com/gabrafur/local-ai-rtx)
é instalado da release `v1.5.1`, commit
`11431302d840e6eb90c33ed8ea5fe68c430b5948`, sob licença MIT. Seu código não é
vendorizado neste repositório. O arquivo exato da release e seu SHA-256 ficam
fixados em `local-ai-integration/local-ai-rtx.lock.json`; o texto MIT acompanha
a release upstream.

## Estado da licença do repositório

Não existe `LICENSE` na raiz por decisão intencional. Um repositório público no
GitHub não se torna automaticamente open source, e o proprietário ainda não
selecionou licença para configuração, documentação, scripts, flows e
integrações originais. Até essa decisão, essas partes seguem as restrições
padrão de copyright. Partes de terceiros continuam sob as licenças acima.

A escolha exige decisão explícita do proprietário e, se necessário, revisão
jurídica—especialmente porque a distribuição contém componentes upstream
modificados. Este aviso é inventário, não aconselhamento jurídico. As opções e
o template atualmente habilitado no GitHub estão no
[memorando de decisão](docs/LICENSING_DECISION.pt-BR.md).
