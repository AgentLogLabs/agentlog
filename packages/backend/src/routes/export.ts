/**
 * @agentlog/backend — 导出 API 路由
 *
 * POST /api/export          根据选项生成导出内容并返回文本
 * GET  /api/export/formats  获取所有支持的导出格式列表
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ExportOptions, ExportFormat, ExportLanguage } from '@agentlog/shared';
import { exportSessions, EXPORT_FORMATS, suggestFilename } from '../services/exportService';

// ─────────────────────────────────────────────
// 请求体 / 查询参数类型
// ─────────────────────────────────────────────

interface ExportBody {
  format: ExportFormat;
  startDate?: string;
  endDate?: string;
  language?: ExportLanguage;
  tags?: string[];
  workspacePath?: string;
  onlyBoundToCommit?: boolean;
  /** 若为 true，以附件形式下载（Content-Disposition: attachment）；默认 false（内联返回） */
  download?: boolean;
}

// ─────────────────────────────────────────────
// JSON Schema（Fastify 校验）
// ─────────────────────────────────────────────

const VALID_FORMATS: ExportFormat[] = ['weekly-report', 'pr-description', 'jsonl', 'csv'];
const VALID_LANGUAGES: ExportLanguage[] = ['zh', 'en'];

const exportBodySchema = {
  type: 'object',
  required: ['format'],
  properties: {
    format: { type: 'string', enum: VALID_FORMATS },
    startDate: { type: 'string' },
    endDate: { type: 'string' },
    language: { type: 'string', enum: VALID_LANGUAGES },
    tags: { type: 'array', items: { type: 'string' } },
    workspacePath: { type: 'string' },
    onlyBoundToCommit: { type: 'boolean' },
    download: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

// ─────────────────────────────────────────────
// 路由注册
// ─────────────────────────────────────────────

export async function exportRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/export/formats
   * 返回所有支持的导出格式，供前端 UI 渲染选项。
   */
  fastify.get('/api/export/formats', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      success: true,
      data: EXPORT_FORMATS,
    });
  });

  /**
   * POST /api/export
   *
   * 根据请求体中的 ExportOptions 生成导出内容。
   *
   * - download=false（默认）：返回 JSON 包装的结果，content 字段为文本字符串。
   * - download=true：直接返回原始文本，并设置 Content-Disposition: attachment，
   *   触发浏览器 / VS Code Webview 下载。
   */
  fastify.post(
    '/api/export',
    { schema: { body: exportBodySchema } },
    async (
      req: FastifyRequest<{ Body: ExportBody }>,
      reply: FastifyReply,
    ) => {
      const {
        format,
        startDate,
        endDate,
        language = 'zh',
        tags,
        workspacePath,
        onlyBoundToCommit,
        download = false,
      } = req.body;

      // 基本日期格式校验（YYYY-MM-DD 或 ISO 8601）
      if (startDate && !isValidDateString(startDate)) {
        return reply.status(400).send({
          success: false,
          error: `startDate 格式无效，请使用 YYYY-MM-DD 或 ISO 8601 格式：${startDate}`,
        });
      }
      if (endDate && !isValidDateString(endDate)) {
        return reply.status(400).send({
          success: false,
          error: `endDate 格式无效，请使用 YYYY-MM-DD 或 ISO 8601 格式：${endDate}`,
        });
      }
      if (startDate && endDate && startDate > endDate) {
        return reply.status(400).send({
          success: false,
          error: 'startDate 不能晚于 endDate',
        });
      }

      const options: ExportOptions = {
        format,
        startDate,
        endDate,
        language,
        tags: tags && tags.length > 0 ? tags : undefined,
        workspacePath,
        onlyBoundToCommit,
      };

      const result = await exportSessions(options);

      // ── 附件下载模式 ──
      if (download) {
        const filename = suggestFilename(format, language);
        const mimeType =
          EXPORT_FORMATS.find((f) => f.value === format)?.mimeType ??
          'text/plain; charset=utf-8';

        return reply
          .status(200)
          .header('Content-Type', mimeType)
          .header(
            'Content-Disposition',
            `attachment; filename="${encodeURIComponent(filename)}"`,
          )
          .send(result.content);
      }

      // ── 内联 JSON 模式（默认）──
      return reply.status(200).send({
        success: true,
        data: result,
      });
    },
  );

  /**
   * POST /api/export/preview
   *
   * 与 /api/export 相同逻辑，但仅返回内容的前 N 行（用于前端预览）。
   * download 参数在此接口无效。
   */
  fastify.post(
    '/api/export/preview',
    { schema: { body: exportBodySchema } },
    async (
      req: FastifyRequest<{ Body: ExportBody }>,
      reply: FastifyReply,
    ) => {
      const {
        format,
        startDate,
        endDate,
        language = 'zh',
        tags,
        workspacePath,
        onlyBoundToCommit,
      } = req.body;

      const options: ExportOptions = {
        format,
        startDate,
        endDate,
        language,
        tags: tags && tags.length > 0 ? tags : undefined,
        workspacePath,
        onlyBoundToCommit,
      };

      const result = await exportSessions(options);

      // 截取前 50 行作为预览
      const previewLines = result.content.split('\n').slice(0, 50);
      const isTruncated = result.content.split('\n').length > 50;

      return reply.status(200).send({
        success: true,
        data: {
          ...result,
          content: previewLines.join('\n') + (isTruncated ? '\n\n…（内容已截断，请下载完整版本）' : ''),
          isTruncated,
        },
      });
    },
  );
}

// ─────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────

/**
 * 校验日期字符串是否合法（宽松校验：YYYY-MM-DD 或 ISO 8601）。
 */
function isValidDateString(value: string): boolean {
  // 简单正则：YYYY-MM-DD 或 YYYY-MM-DDTHH:mm...
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}
