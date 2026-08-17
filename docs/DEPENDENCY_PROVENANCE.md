# Proveniência das dependências de validação

As dependências operacionais permanecem declaradas nos packages e nas imagens
com lockfiles ou digests. A validação pública adiciona somente o parser
`yaml@2.9.0`, fixado em `validation/package-lock.json`, instalado sem lifecycle
scripts por `make validate-public`. Node-RED continua reproduzível por
`nodered/package-lock.json`; as imagens de Compose permanecem presas a digests.

Atualizações devem alterar a declaração e o lockfile na mesma mudança, passar
pelos scanners e preservar a origem oficial do registry npm ou da imagem.
