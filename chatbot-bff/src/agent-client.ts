import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'

const region = process.env.AWS_REGION || 'us-east-1'

const client = new BedrockAgentCoreClient({ region })

async function* readWebStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) {
        yield value
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function toAsyncIterable(stream: unknown): AsyncIterable<Uint8Array> {
  // In Node/Lambda the AWS SDK may return an async-iterable SdkStream instead of
  // a browser-style ReadableStream, so callers must not assume getReader() exists.
  if (
    stream &&
    typeof stream === 'object' &&
    Symbol.asyncIterator in stream &&
    typeof (stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
  ) {
    return stream as AsyncIterable<Uint8Array>
  }

  if (
    stream &&
    typeof stream === 'object' &&
    'getReader' in stream &&
    typeof (stream as ReadableStream<Uint8Array>).getReader === 'function'
  ) {
    return readWebStream(stream as ReadableStream<Uint8Array>)
  }

  throw new TypeError('Unsupported AgentCore response stream type.')
}

export interface InvokeAgentInput {
  message: string
  sessionId: string
  agentRuntimeArn: string
  /** Ties this invocation to the browser request and the BFF log lines that describe it. */
  correlationId?: string
}

export async function invokeAgentStream(input: InvokeAgentInput): Promise<AsyncIterable<Uint8Array>> {
  const command = new InvokeAgentRuntimeCommand({
    runtimeSessionId: input.sessionId,
    agentRuntimeArn: input.agentRuntimeArn,
    qualifier: 'DEFAULT',
    // Only `baggage`, and deliberately not `traceId` or `traceParent`.
    //
    // Those two map to the `X-Amzn-Trace-Id` and `traceparent` headers, and the SDK includes them in
    // the SigV4 signature. The OpenTelemetry AWS SDK instrumentation then injects its own values for
    // the same headers *after* signing, so the request arrives with a header that differs from the
    // one signed and AgentCore rejects it: "The request signature we calculated does not match the
    // signature you provided." SigV4 tolerates *extra* headers; it does not tolerate a signed one
    // being rewritten. Propagating trace context is the instrumentation's job now — it does it
    // better than deriving it by hand, because it attaches to the active span rather than the root.
    //
    // `baggage` stays because nothing else sets it: the instrumentation injects a baggage header
    // only when the OTel baggage is non-empty, and ours never is. It is also what carries the
    // correlation id when tracing is off entirely.
    ...(input.correlationId ? { baggage: `correlationId=${input.correlationId}` } : {}),
    payload: new TextEncoder().encode(input.message),
  })

  const result = await client.send(command)

  if (!result.response) {
    throw new Error('No response body from AgentCore (SigV4).')
  }

  return toAsyncIterable(result.response)
}
