'use strict';

const TRANSIENT_NETWORK = /failed to lookup address information|temporary failure in name resolution|\bEAI_AGAIN\b|\bENOTFOUND\b|failed to connect to websocket/i;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

function isTransientNetworkError(error) {
  return TRANSIENT_NETWORK.test(errorMessage(error));
}

async function retryTransientNetwork(operation, {
  attempts = 2,
  delayMs = 2000,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt === attempts) throw error;
      await wait(delayMs);
    }
  }
  throw lastError;
}

function publicAgentError(agentName, error) {
  const message = errorMessage(error);
  if (isTransientNetworkError(error)) {
    return `Não foi possível acessar ${agentName} porque a resolução DNS/rede externa está indisponível. A tentativa automática também falhou; tente novamente quando a conexão retornar.`;
  }
  if (/timed out/i.test(message)) {
    return `${agentName} excedeu o tempo limite e a execução foi encerrada com segurança.`;
  }
  return `Não foi possível executar ${agentName}. O erro técnico foi registrado sem expor a saída interna no chat.`;
}

function safeErrorCategory(error) {
  if (isTransientNetworkError(error)) return 'transient_network';
  if (/timed out/i.test(errorMessage(error))) return 'timeout';
  return 'execution_failed';
}

module.exports = {
  isTransientNetworkError,
  publicAgentError,
  retryTransientNetwork,
  safeErrorCategory,
};
