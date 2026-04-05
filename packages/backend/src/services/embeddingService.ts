/**
 * @agentlog/backend — Embedding Service
 *
 * 提供文本嵌入功能，用于语义搜索 pending traces。
 *
 * Stage 1 实现策略:
 * - 优先使用 Ollama API (如果可用)
 * - 回退到简单关键词匹配
 *
 * 未来升级: all-MiniLM-L6-v2 / ChromaDB / PostgreSQL pgvector
 */

// Ollama API URL (如果使用本地模型)
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

// ─────────────────────────────────────────────
// 简单文本相似度（基于 TF-IDF 风格）
// ─────────────────────────────────────────────

/**
 * 简单的词频统计（Bag of Words）相似度。
 * 作为无外部依赖时的回退方案。
 */
function simpleTextSimilarity(text1: string, text2: string): number {
  const words1 = extractWords(text1);
  const words2 = extractWords(text2);

  // 构建词频向量
  const allWords = new Set([...words1.keys(), ...words2.keys()]);
  const vec1: number[] = [];
  const vec2: number[] = [];

  for (const word of allWords) {
    vec1.push(words1.get(word) ?? 0);
    vec2.push(words2.get(word) ?? 0);
  }

  // 计算余弦相似度
  return cosineSimilarity(vec1, vec2);
}

function extractWords(text: string): Map<string, number> {
  const words = text.toLowerCase().split(/\s+/);
  const freq = new Map<string, number>();
  for (const word of words) {
    if (word.length > 2) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  return freq;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// ─────────────────────────────────────────────
// Embedding 接口
// ─────────────────────────────────────────────

export interface EmbeddingResult {
  embedding: number[];
  model: string;
}

/**
 * 使用 Ollama API 生成 embedding。
 */
async function getEmbeddingFromOllama(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API 错误: ${response.status}`);
  }

  const data = await response.json() as { embedding: number[] };
  return data.embedding;
}

/**
 * 将文本转为 embedding 向量。
 * 优先使用 Ollama API，失败则使用简单词频相似度。
 */
export async function encodeText(text: string): Promise<number[]> {
  try {
    // 优先使用 Ollama
    return await getEmbeddingFromOllama(text);
  } catch (err) {
    console.log(`[Embedding] Ollama 不可用，使用简单相似度: ${err}`);
    // 回退：使用词频向量作为 "fake embedding"
    // 注意：这不是真正的语义嵌入，仅用于关键词匹配
    return textToFakeEmbedding(text);
  }
}

/**
 * 将文本转为固定维度的 "fake embedding"（词频向量）。
 * 作为无外部服务时的回退方案。
 */
function textToFakeEmbedding(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/);
  const freq = new Map<string, number>();
  for (const word of words) {
    if (word.length > 2) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  // 返回词频数组（维度不固定，仅用于内部相似度计算）
  return Array.from(freq.values());
}

// ─────────────────────────────────────────────
// 内存向量存储（Stage 1）
// ─────────────────────────────────────────────

interface VectorEntry {
  traceId: string;
  taskGoal: string;
  textSignature: string; // 用于简单相似度计算
  createdAt: string;
}

const vectorStore = new Map<string, VectorEntry>();

/**
 * 存储 trace 的文本签名（用于相似度匹配）。
 */
export async function storeTraceEmbedding(
  traceId: string,
  taskGoal: string,
  createdAt: string
): Promise<void> {
  vectorStore.set(traceId, {
    traceId,
    taskGoal,
    textSignature: taskGoal.toLowerCase(),
    createdAt,
  });
  console.log(`[Embedding] 已存储 trace ${traceId}`);
}

/**
 * 删除 trace 的 embedding。
 */
export function deleteTraceEmbedding(traceId: string): void {
  vectorStore.delete(traceId);
}

/**
 * 清除所有 embeddings。
 */
export function clearAllEmbeddings(): void {
  vectorStore.clear();
  console.log(`[Embedding] 已清除所有 embeddings`);
}

/**
 * 语义搜索 traces。
 * 返回与查询文本最相似的 traces。
 */
export async function searchTracesByEmbedding(
  query: string,
  limit: number = 5
): Promise<Array<{ traceId: string; taskGoal: string; score: number; createdAt: string }>> {
  const results: Array<{ traceId: string; taskGoal: string; score: number; createdAt: string }> = [];

  for (const entry of vectorStore.values()) {
    const score = simpleTextSimilarity(query, entry.textSignature);
    results.push({
      traceId: entry.traceId,
      taskGoal: entry.taskGoal,
      score,
      createdAt: entry.createdAt,
    });
  }

  // 按相似度降序排序
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

/**
 * 获取存储的 trace 数量。
 */
export function getStoredTraceCount(): number {
  return vectorStore.size;
}
