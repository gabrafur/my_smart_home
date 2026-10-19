# Avisos de terceiros

[Português](THIRD_PARTY_NOTICES.pt-BR.md) · [English](THIRD_PARTY_NOTICES.md)

Este repositório distribui código-fonte de terceiros junto com configuração e
ferramentas próprias. Os avisos abaixo valem somente para o código upstream
identificado. O trabalho original do repositório está sob
[GPL-3.0-only](LICENSE).

## Integrações vendorizadas do Home Assistant

| Componente | Revisão upstream | Licença | Caminho coberto | Estado local |
| --- | --- | --- | --- | --- |
| Alexa Media Player | `v5.17.0` / `8a9c03ed7c84be90fe4bf76a8eafcd496f4d048f` | Apache-2.0 | `homeassistant/custom_components/alexa_media/**` | guard do coordenador incorporado upstream; sem delta local de código |
| HACS | `2.0.5` / `c0dfd8b44297c3673c21973e2539375a53687a9c` | MIT | `homeassistant/custom_components/hacs/**` | metadata de versão e HA mínimo alterada localmente |
| Kia Uvo / Hyundai Bluelink | `v3.17.1` / `417f6ac5fe65521e7948015a278c82ee5a584a71` | MIT | `homeassistant/custom_components/kia_uvo/**` | modificado; consulte a origem imobilizada |

O texto de cada licença foi preservado como `LICENSE.upstream` no diretório do
componente. Copyright continua com os autores upstream. Nomes e marcas são
usados somente para identificar dependências.

Origens, método de comparação, modificações, atualização, dependências
gerenciadas e deveres de atribuição estão no guia de
[proveniência](docs/DEPENDENCY_PROVENANCE.md).

## Recursos de interface do Home Assistant Core

A adaptação local `icloud` inclui recursos de interface do Home Assistant Core
2026.10.1 (`abe1fdd7cd6b4de1715c87b6fd87d92699514ef9`), sob Apache-2.0.
As descrições da etapa de verificação e os exemplos de conta dos serviços foram
alterados. Os hashes originais
e o digest da imagem oficial constam de `upstream.json`; a licença original está
em `homeassistant/custom_components/icloud/LICENSE.upstream`. O código Python
da adaptação delega à integração Core instalada.

## Runtime Local AI externo


O runtime opcional [`local-ai-rtx`](https://github.com/gabrafur/local-ai-rtx)
é instalado da release `v1.5.1`, commit
`11431302d840e6eb90c33ed8ea5fe68c430b5948`, sob licença MIT. Seu código não é
vendorizado neste repositório. O arquivo exato da release e seu SHA-256 ficam
fixados em `local-ai-integration/local-ai-rtx.lock.json`; o texto MIT acompanha
a release upstream.

## Estado da licença do repositório

A [LICENSE](LICENSE) raiz aplica `GPL-3.0-only` ao trabalho original do projeto.
Ela não substitui copyright nem licenças Apache-2.0 e MIT específicas dos
arquivos vendorizados. Modificações locais nesses componentes devem preservar
avisos upstream e cumprir os respectivos termos. Este aviso é um inventário,
não uma declaração de titularidade sobre código de terceiros.
