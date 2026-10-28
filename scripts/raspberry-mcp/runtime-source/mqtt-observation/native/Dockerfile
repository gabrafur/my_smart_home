# Exact ARM64 broker base used by the isolated ABI/runtime acceptance.
# SDK files are supplied by prepare_build.py with SHA-256 and Git blob checks.
FROM eclipse-mosquitto@sha256:860aeb5d63ce509508f6dcfb2bc8a1c1dd2bc60555b562b45ce90e52d8dabb0f AS build
USER root
RUN apk add --no-cache gcc musl-dev
WORKDIR /source
COPY sdk ./sdk
COPY native_sender_authorized.c fault_harness_authorized.c ./
RUN mkdir /artifacts && \
    cc -std=c11 -Wall -Wextra -Werror -O2 -fPIC -fstack-protector-strong \
      -D_FORTIFY_SOURCE=2 -shared -Wl,-z,relro,-z,now -Isdk/include \
      native_sender_authorized.c -o /artifacts/observer.so && \
    cc -std=c11 -Wall -Wextra -Werror -O2 -pthread -fstack-protector-strong \
      -D_FORTIFY_SOURCE=2 -Wl,-z,relro,-z,now -Isdk/include \
      fault_harness_authorized.c -o /artifacts/fault-harness

FROM scratch AS artifacts
COPY --from=build /artifacts/ /
COPY sdk/LICENSE.txt sdk/edl-v10 sdk/epl-v20 /licenses/mosquitto-sdk/
COPY sdk-manifest.json /licenses/mosquitto-sdk/sdk-manifest.json
COPY LICENSE.project /licenses/project/LICENSE
