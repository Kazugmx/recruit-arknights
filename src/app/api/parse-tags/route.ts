import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { getVisionClient } from '@/lib/google-vision';
import { OCR_SECURITY, OCR_TIMEOUT } from '@/lib/constants';
import { allTags } from "@/lib/utils";
import levenshtein from 'fast-levenshtein';

// タグキーワードをメモリにキャッシュ
const TAG_KEYWORDS = allTags;

// ファジーマッチングの許容割合（実証済みの最適値）
const FUZZY_THRESHOLD_RATIO = 0.3;

// 結果キャッシュ（同じ画像に対する重複リクエストを防止）
const resultCache = new Map<string, string[]>();
const CACHE_MAX_SIZE = 50; // キャッシュの最大サイズ
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_BASE64_LENGTH = Math.ceil(OCR_SECURITY.MAX_IMAGE_BYTES / 3) * 4;
const RATE_LIMIT_CACHE_MAX_SIZE = 10_000;

type RateLimitEntry = {
    count: number;
    resetAt: number;
};

// プロセス内での第一段階の保護。複数インスタンス環境では WAF/CDN の
// レート制限も必ず設定する。
const rateLimitCache = new Map<string, RateLimitEntry>();
let activeOcrRequests = 0;

const getClientId = (req: NextRequest): string => {
    const forwardedFor = req.headers.get('x-forwarded-for');
    return forwardedFor?.split(',')[0]?.trim()
        || req.headers.get('x-real-ip')
        || 'unknown';
};

const isRateLimited = (clientId: string): boolean => {
    const now = Date.now();

    if (rateLimitCache.size >= RATE_LIMIT_CACHE_MAX_SIZE) {
        for (const [key, value] of rateLimitCache) {
            if (value.resetAt <= now) rateLimitCache.delete(key);
        }
        if (rateLimitCache.size >= RATE_LIMIT_CACHE_MAX_SIZE) {
            const oldestKey = rateLimitCache.keys().next().value;
            if (oldestKey) rateLimitCache.delete(oldestKey);
        }
    }

    const entry = rateLimitCache.get(clientId);

    if (!entry || entry.resetAt <= now) {
        rateLimitCache.set(clientId, {
            count: 1,
            resetAt: now + OCR_SECURITY.RATE_LIMIT_WINDOW_MS,
        });
        return false;
    }

    entry.count += 1;
    return entry.count > OCR_SECURITY.MAX_REQUESTS_PER_WINDOW;
};

const isSupportedImage = (buffer: Buffer): boolean => {
    const isPng = buffer.length >= 8
        && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = buffer.length >= 3
        && buffer[0] === 0xff
        && buffer[1] === 0xd8
        && buffer[2] === 0xff;
    const isWebp = buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP';

    return isPng || isJpeg || isWebp;
};

const errorResponse = (error: string, status: number) =>
    NextResponse.json(
        { error },
        {
            status,
            headers: { 'Cache-Control': 'no-store' },
        },
    );

/**
 * ファジーマッチング関数
 * @param target OCR 結果の行
 * @param keyword 比較対象のタグ
 */
const isFuzzyMatch = (target: string, keyword: string): boolean => {
    // 完全一致の場合は即時返却
    if (target === keyword) return true;

    // 職業タイプの特別処理（「先鋒タイプ」→「先鋒」など）
    const typeKeywords = ['先鋒', '前衛', '狙撃', '術師', '重装', '医療', '補助', '特殊'];
    if (typeKeywords.includes(keyword)) {
        // 「先鋒タイプ」のようなパターンをチェック
        const typeRegex = new RegExp(`${keyword}(タイプ|職業|クラス)?`, 'i');
        if (typeRegex.test(target)) return true;
    }

    // 通常の単語境界チェック
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    if (regex.test(target)) return true;

    // 単語境界なしでもチェック（部分一致）
    const partialRegex = new RegExp(keyword, 'i');
    if (partialRegex.test(target)) {
        // 短いキーワード（3文字以下）は誤検出が多いため、追加チェック
        if (keyword.length <= 3) {
            // 短いキーワードは単語の一部として含まれる可能性が高いため、
            // 前後の文字をチェックして誤検出を減らす
            return false;
        }
        return true;
    }

    // Levenshtein距離による判定
    const distance = levenshtein.get(target.toLowerCase(), keyword.toLowerCase());
    const threshold = Math.floor(keyword.length * FUZZY_THRESHOLD_RATIO);
    return distance <= threshold;
};

/**
 * 画像ハッシュの生成
 * SHA-256を使用して画像全体から一意なハッシュを生成する。
 * 以前の先頭100文字によるキーはCanvas JPEGエンコード時に
 * 全画像で共通のJPEGヘッダー部分が一致してしまい衝突が発生していた。
 */
const generateImageHash = (imageBase64: string): string => {
    return createHash('sha256').update(imageBase64).digest('hex');
};

/**
 * キャッシュ管理関数
 */
const manageCache = () => {
    // キャッシュサイズが上限を超えた場合、古いエントリを削除
    if (resultCache.size > CACHE_MAX_SIZE) {
        const keysToDelete = Array.from(resultCache.keys()).slice(0, Math.floor(CACHE_MAX_SIZE / 4));
        keysToDelete.forEach(key => resultCache.delete(key));
    }
};

export async function POST(req: NextRequest) {
    let hasOcrSlot = false;

    try {
        if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
            return errorResponse('Content-Type must be application/json.', 415);
        }

        const contentLength = req.headers.get('content-length');
        if (contentLength) {
            const contentLengthNumber = Number(contentLength);
            if (!Number.isSafeInteger(contentLengthNumber) || contentLengthNumber > MAX_BASE64_LENGTH + 1024) {
                return errorResponse('Image data is too large.', 413);
            }
        }

        const origin = req.headers.get('origin');
        if (origin && origin !== new URL(req.url).origin) {
            return errorResponse('Cross-origin requests are not allowed.', 403);
        }

        if (isRateLimited(getClientId(req))) {
            return errorResponse('Too many requests. Please try again later.', 429);
        }

        const body = await req.json();
        const { imageBase64 } = body;

        if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
            return errorResponse('No image data provided.', 400);
        }

        if (imageBase64.length > MAX_BASE64_LENGTH || !BASE64_PATTERN.test(imageBase64)) {
            return errorResponse('Invalid image data.', 400);
        }

        const buffer = Buffer.from(imageBase64, 'base64');
        if (buffer.length === 0 || buffer.length > OCR_SECURITY.MAX_IMAGE_BYTES || !isSupportedImage(buffer)) {
            return errorResponse('Unsupported or oversized image.', 400);
        }

        // キャッシュチェック
        const imageHash = generateImageHash(imageBase64);
        if (resultCache.has(imageHash)) {
            return NextResponse.json({
                tags: resultCache.get(imageHash),
                cached: true
            }, { headers: { 'Cache-Control': 'no-store' } });
        }

        if (activeOcrRequests >= OCR_SECURITY.MAX_CONCURRENT_REQUESTS) {
            return errorResponse('The OCR service is busy. Please try again shortly.', 503);
        }

        activeOcrRequests += 1;
        hasOcrSlot = true;

        const client = getVisionClient();

        const [visionResponse] = await client.batchAnnotateImages(
            {
                requests: [{
                    image: { content: buffer },
                    features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
                    imageContext: {
                        languageHints: ["ja", "en"],
                    },
                }],
            },
            { timeout: OCR_TIMEOUT.SERVER_MS },
        );
        const result = visionResponse.responses?.[0];

        const detections = result?.fullTextAnnotation?.text || '';

        const lines: string[] = detections
            .split('\n')
            .map((line: string) => line.trim())
            .filter((line: string) => line.length > 1); // 1文字以下の行は無視

        // 結果を格納する Set
        const foundTags = new Set<string>();

        // 特殊なタグを先に処理（優先度の高いタグ）
        const specialTags = ["上級エリート", "エリート", "ロボット"];
        const regularTags = TAG_KEYWORDS.filter(tag => !specialTags.includes(tag));

        // 特殊タグの処理
        for (const line of lines) {
            // 上級エリートの処理
            if (isFuzzyMatch(line, "上級エリート")) {
                foundTags.add("上級エリート");

                // 行内に「上級エリート」以外の独立した「エリート」が存在するかチェック
                if (/(?<!上級)エリート/.test(line)) {
                    foundTags.add("エリート");
                }
                continue;
            }

            // エリートの処理
            if (isFuzzyMatch(line, "エリート")) {
                foundTags.add("エリート");
                continue;
            }

            // ロボットの処理
            if (isFuzzyMatch(line, "ロボット")) {
                foundTags.add("ロボット");
            }
        }

        // 通常タグの処理
        const tagPromises = lines.map(async (line) => {
            const matchedTags = regularTags.filter(tag => isFuzzyMatch(line, tag));
            return matchedTags;
        });

        const tagResults = await Promise.all(tagPromises);
        tagResults.flat().forEach(tag => foundTags.add(tag));

        const uniqueTags = Array.from(foundTags);

        // キャッシュに結果を保存
        resultCache.set(imageHash, uniqueTags);
        manageCache();

        // デバッグ情報（本番環境では削除または条件付きで出力）
        if (process.env.NODE_ENV === 'development') {
            console.log("OCR取得結果の行:", lines);
            console.log("抽出されたタグ:", uniqueTags);
        }

        return NextResponse.json({ tags: uniqueTags }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        console.error("OCR処理エラー:", error);

        // 詳細なエラーはサーバーログにのみ残し、認証情報・上流 API の応答を公開しない。
        if (error instanceof Error) {
            if (error.message.includes('timeout')) {
                return errorResponse('Request timeout. Please try again.', 504);
            }
        }

        return errorResponse('Unable to analyze the image. Please try again later.', 500);
    } finally {
        if (hasOcrSlot) {
            activeOcrRequests -= 1;
        }
    }
}
