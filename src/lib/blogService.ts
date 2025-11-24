import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchPosts,
  fetchPostBySlug,
  fetchCategories,
  type WpPost,
  type WpCategory,
} from "@/lib/wordpressApi";
import {
  CATEGORY_PRESENTATION,
  DEFAULT_CATEGORY_PRESENTATION,
  type CategoryPresentation,
} from "@/config/blogCategories";

interface FeaturedImage {
  src: string;
  alt?: string;
}

export interface BlogCategoryInfo {
  id: number;
  slug: string;
  name: string;
  description?: string;
  icon: string;
  color: string;
  metaDescription?: string;
  count?: number;
}

export interface BlogPostSummary {
  id: number;
  slug: string;
  title: string;
  excerptHtml: string;
  excerptText: string;
  dateIso: string;
  dateFormatted: string;
  readTime: string;
  category: BlogCategoryInfo;
  featuredImage: FeaturedImage | null;
  canonicalUrl: string;
}

export interface BlogLeadImage {
  src: string;
  alt?: string;
}

export interface BlogAuthorInfo {
  name: string;
  bio?: string;
  avatarUrl?: string;
  role?: string;
}

export interface BlogPostDetails extends BlogPostSummary {
  contentHtml: string;
  leadImage?: BlogLeadImage | null;
  metaDescription?: string;
  yoast?: WpPost["yoast_head_json"];
  author: BlogAuthorInfo;
}

export interface BlogPostDetailsResult {
  post: BlogPostDetails;
  previousPost: BlogPostSummary | null;
  nextPost: BlogPostSummary | null;
  relatedPosts: BlogPostSummary[];
}

export interface BlogPostsResult {
  items: BlogPostSummary[];
  total: number;
  totalPages: number;
}

export interface BlogPostsQueryParams {
  page?: number;
  perPage?: number;
  categoryId?: number;
}

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

const stripHtml = (html: string) =>
  html
    .replace(/<\/?(script|style)[^>]*>.*?<\/\1>/gims, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const calculateReadTime = (html: string) => {
  const text = stripHtml(html);
  const words = text.length > 0 ? text.split(/\s+/).length : 0;
  const minutes = Math.max(1, Math.ceil(words / 200));
  return `${minutes} min read`;
};

const normalizeLazyImages = (html: string) =>
  html.replace(/<img\b[^>]*>/gi, (tag) => {
    const getAttr = (name: string) => {
      const attrRegex = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
      return attrRegex.exec(tag)?.[1];
    };

    const setAttr = (name: string, value: string) => {
      if (new RegExp(`${name}\\s*=`, "i").test(tag)) {
        return tag.replace(new RegExp(`${name}\\s*=\\s*["'][^"']*["']`, "i"), `${name}="${value}"`);
      }
      return tag.replace(/<img/i, `<img ${name}="${value}"`);
    };

    const extractFromSrcset = (value?: string | null) => {
      if (!value) return undefined;
      const firstCandidate = value.split(",")[0]?.trim();
      return firstCandidate?.split(" ")[0];
    };

    const dataSrc = getAttr("data-src") ?? getAttr("data-lazy-src") ?? getAttr("data-original") ?? getAttr("data-url");
    const dataSrcset = extractFromSrcset(getAttr("data-srcset") ?? getAttr("data-lazy-srcset"));
    const srcsetCandidate = extractFromSrcset(getAttr("srcset"));
    const rawSrc = getAttr("src");

    let resolvedSrc = dataSrc || dataSrcset || srcsetCandidate || rawSrc;

    if (resolvedSrc && resolvedSrc.startsWith("data:image")) {
      resolvedSrc = dataSrcset || srcsetCandidate || undefined;
    }

    let updatedTag = tag;
    if (resolvedSrc && resolvedSrc !== rawSrc) {
      updatedTag = setAttr("src", resolvedSrc);
    }

    const dataSrcsetAttr = getAttr("data-srcset") ?? getAttr("data-lazy-srcset");
    if (dataSrcsetAttr && !/\bsrcset\s*=/.test(updatedTag)) {
      updatedTag = setAttr("srcset", dataSrcsetAttr);
    }

    return updatedTag;
  });

const decodeCommonEntities = (value: string) =>
  value.replace(/&(amp|#0*38);/gi, "&");

const normalizeRawUrl = (raw: string | null | undefined) =>
  raw ? decodeCommonEntities(raw).replace(/\\\//g, "/") : raw ?? null;

const buildYoutubeEmbedUrl = (rawUrl: string): string | null => {
  const cleanedUrl = normalizeRawUrl(rawUrl)?.trim();
  if (!cleanedUrl) return null;

  const ensureAbsolute = (url: string) => (url.startsWith("//") ? `https:${url}` : url);

  try {
    const url = new URL(ensureAbsolute(cleanedUrl), "https://youtube.com");
    const hostname = url.hostname.replace(/^www\./i, "");
    const isYoutubeHost =
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtube-nocookie.com" ||
      hostname.endsWith(".youtube-nocookie.com");

    let videoId: string | null = null;

    if (hostname === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (isYoutubeHost) {
      if (url.pathname === "/watch") {
        videoId = url.searchParams.get("v");
      } else if (url.pathname.startsWith("/embed/") || url.pathname.startsWith("/shorts/")) {
        videoId = url.pathname.split("/").filter(Boolean)[1] ?? null;
      }
    }

    // If we couldn't confidently extract an ID but it's already an embed URL, just return it normalized
    if (!videoId && isYoutubeHost && url.pathname.startsWith("/embed/")) {
      return ensureAbsolute(cleanedUrl);
    }

    if (!videoId) return null;

    const params = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
      if (key.toLowerCase() === "v") return;
      params.set(key, value);
    });

    const query = params.toString();
    const separator = query ? `?${query}&` : "?";
    return `https://www.youtube.com/embed/${videoId}${separator}rel=0&modestbranding=1`;
  } catch {
    return null;
  }
};

const buildSoundcloudEmbedUrl = (rawUrl: string): string | null => {
  const cleanedUrl = normalizeRawUrl(rawUrl)?.trim();
  if (!cleanedUrl) return null;

  const ensureAbsolute = (url: string) => (url.startsWith("//") ? `https:${url}` : url);

  try {
    const url = new URL(ensureAbsolute(cleanedUrl), "https://soundcloud.com");
    const hostname = url.hostname.replace(/^www\./i, "");
    const isSoundcloud = hostname === "soundcloud.com" || hostname.endsWith(".soundcloud.com") || hostname === "w.soundcloud.com";

    if (!isSoundcloud) return null;

    // Already an embed URL
    if (hostname === "w.soundcloud.com" && url.pathname.includes("/player")) {
      return ensureAbsolute(cleanedUrl);
    }

    const base = "https://w.soundcloud.com/player/";
    const params = new URLSearchParams();
    params.set("url", url.toString());
    params.set("auto_play", "false");
    params.set("hide_related", "false");
    params.set("show_comments", "true");
    params.set("show_user", "true");
    params.set("show_reposts", "false");
    params.set("visual", "true");

    return `${base}?${params.toString()}`;
  } catch {
    return null;
  }
};

const extractYoutubeId = (rawUrl: string | null | undefined): string | null => {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl, "https://youtube.com");
    const host = url.hostname.replace(/^www\./i, "");
    const isYoutube =
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com") ||
      host === "youtu.be";

    if (!isYoutube) return null;

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    if (url.pathname === "/watch") {
      return url.searchParams.get("v");
    }

    if (url.pathname.startsWith("/embed/") || url.pathname.startsWith("/shorts/")) {
      return url.pathname.split("/").filter(Boolean)[1] ?? null;
    }
  } catch {
    return null;
  }
  return null;
};

const convertEmbedsToIframes = (html: string): string => {
  if (!html) return html;

  const getProvider = (embedUrl: string): "youtube" | "soundcloud" => {
    return /soundcloud\.com/.test(embedUrl) ? "soundcloud" : "youtube";
  };

  const iframeTemplate = (embedUrl: string) => {
    const provider = getProvider(embedUrl);
    if (provider === "soundcloud") {
      return `<div class="wp-block-embed__wrapper"><iframe width="100%" height="320" scrolling="no" frameborder="no" allow="autoplay" src="${embedUrl}" title="SoundCloud player" loading="lazy"></iframe></div>`;
    }
    return `<div class="wp-block-embed__wrapper"><iframe src="${embedUrl}" title="YouTube video player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  };

  const decodeSettings = (value: string) =>
    value.replace(/&quot;/g, "\"").replace(/&#34;/g, "\"").replace(/&amp;/g, "&").replace(/\\\//g, "/");

  const resolveEmbedUrl = (raw: string | null | undefined) => {
    const normalized = normalizeRawUrl(raw);
    return (normalized && (buildYoutubeEmbedUrl(normalized) ?? buildSoundcloudEmbedUrl(normalized))) || null;
  };

  const findYoutubeUrl = (text: string) => {
    const match = normalizeRawUrl(text)?.match(/https?:\/\/[^\s"'<>]*(?:youtube\.com|youtu\.be)[^\s"'<>]*/i);
    return match ? buildYoutubeEmbedUrl(match[0]) ?? match[0] : null;
  };

  const findSoundcloudUrl = (text: string) => {
    const match = normalizeRawUrl(text)?.match(/https?:\/\/[^\s"'<>]*soundcloud\.com[^\s"'<>]*/i);
    return match ? buildSoundcloudEmbedUrl(match[0]) ?? match[0] : null;
  };

  const findEmbedUrl = (text: string) => findYoutubeUrl(text) ?? findSoundcloudUrl(text);

  const extractYoutubeFromSettings = (raw: string) => {
    const decoded = decodeSettings(raw);
    try {
      const parsed = JSON.parse(decoded);
      const candidate =
        (parsed as Record<string, unknown>).youtube_url ??
        (parsed as Record<string, unknown>).youtubeURL ??
        (parsed as Record<string, unknown>).url;
      if (typeof candidate === "string") {
        return candidate;
      }
    } catch {
      // Fall back to regex scanning
    }
    return findYoutubeUrl(decoded);
  };

  const convertWpFigures = (input: string) =>
    input.replace(/<figure\b[^>]*wp-block-embed[^>]*>[\s\S]*?<\/figure>/gi, (figureMatch) => {
      if (/<iframe\b/i.test(figureMatch)) {
        return figureMatch;
      }

      const wrapperMatch = figureMatch.match(/<div\b[^>]*wp-block-embed__wrapper[^>]*>([\s\S]*?)<\/div>/i);
      const rawUrl = wrapperMatch?.[1]?.replace(/<\/?p[^>]*>/gi, "").trim();
      const embedUrl = resolveEmbedUrl(rawUrl);
      if (!embedUrl || !wrapperMatch) {
        return figureMatch;
      }

      return figureMatch.replace(wrapperMatch[0], iframeTemplate(embedUrl));
    });

  const convertBlockquotes = (input: string) =>
    input.replace(
      /<blockquote\b[^>]*wp-embedded-content[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/blockquote>/gi,
      (blockquoteMatch, href) => {
        const embedUrl = resolveEmbedUrl(href);
        if (!embedUrl) {
          return blockquoteMatch;
        }
        return iframeTemplate(embedUrl);
      }
    );

  const convertElementorPlaceholders = (input: string) => {
    const placeholderRegex = /<div\b[^>]*class="[^"]*elementor-video[^"]*"[^>]*>\s*<\/div>/gi;
    let output = input;
    let match: RegExpExecArray | null;

    while ((match = placeholderRegex.exec(output)) !== null) {
      const currentMatch = match;
      const startIndex = currentMatch.index;
      const contextStart = Math.max(0, startIndex - 4000);
      const context = output.slice(contextStart, startIndex);
      const afterPlaceholder = output.slice(startIndex + currentMatch[0].length);
      const noscriptAfterMatch = afterPlaceholder.match(/^\s*(<noscript>[\s\S]*?<\/noscript>)/i);
      const noscriptBlock = noscriptAfterMatch?.[1];
      const noscriptUrl = noscriptBlock?.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];

      const settingsMatch = context.match(/data-settings=(["'])([\s\S]*?youtube_url[\s\S]*?)\1/i);
      const urlFromSettings = settingsMatch ? extractYoutubeFromSettings(settingsMatch[2]) : null;
      const urlFromNoscript = noscriptUrl ? resolveEmbedUrl(noscriptUrl) ?? noscriptUrl : null;
      const embedUrl = urlFromSettings
        ? resolveEmbedUrl(urlFromSettings) ?? urlFromSettings
        : urlFromNoscript ?? findEmbedUrl(context + (noscriptBlock ?? ""));

      if (!embedUrl) {
        continue;
      }

      const replacement = iframeTemplate(embedUrl);

      const removeNoscript =
        noscriptBlock &&
        noscriptUrl &&
        (embedUrl.includes(noscriptUrl) || embedUrl === buildYoutubeEmbedUrl(noscriptUrl));
      const skipLength =
        currentMatch[0].length + (removeNoscript ? noscriptAfterMatch?.[0].length ?? 0 : 0);

      output = output.slice(0, startIndex) + replacement + output.slice(startIndex + skipLength);
      placeholderRegex.lastIndex = startIndex + replacement.length;
    }

    return output;
  };

  const convertElementskitVideoLinks = (input: string) =>
    input.replace(/<a[^>]*class="[^"]*(?:ekit-video-popup|ekit-video-popup-btn)[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi, (anchorMatch, href) => {
      const embedUrl = buildYoutubeEmbedUrl(decodeSettings(href)) ?? findYoutubeUrl(anchorMatch);
      if (!embedUrl) return anchorMatch;
      return iframeTemplate(embedUrl);
    });

  const convertParagraphLinks = (input: string) =>
    input.replace(/<p>\s*<a[^>]+href="([^"]*(?:youtu[^"]+|soundcloud[^"]+))"[^>]*>[^<]*<\/a>\s*<\/p>/gi, (pMatch, href) => {
      const embedUrl = resolveEmbedUrl(href);
      if (!embedUrl) return pMatch;
      return iframeTemplate(embedUrl);
    });

  const convertBareLinks = (input: string) =>
    input.replace(/<p>\s*(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|soundcloud\.com)\/[^\s<]+)\s*<\/p>/gi, (pMatch, href) => {
      const embedUrl = resolveEmbedUrl(href);
      if (!embedUrl) return pMatch;
      return iframeTemplate(embedUrl);
    });

  const convertLazyYoutubeDivs = (input: string) =>
    input.replace(/<div[^>]*class="[^"]*rll-youtube-player[^"]*"[^>]*data-src="([^"]+)"[^>]*>([\s\S]*?)<\/div>/gi, (divMatch, dataSrc) => {
      const embedUrl = buildYoutubeEmbedUrl(dataSrc) ?? dataSrc;
      if (!embedUrl) return divMatch;
      return iframeTemplate(embedUrl);
    });

  const convertSoundcloudIframes = (input: string) =>
    input.replace(/<iframe\b([^>]*)>([\s\S]*?)<\/iframe>/gi, (fullMatch, attrs, inner) => {
      const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
      const dataSrcMatch = attrs.match(/\bdata-[\w-]*src=["']([^"']+)["']/i);
      const candidate = srcMatch?.[1] || dataSrcMatch?.[1];
      const embedUrl = resolveEmbedUrl(candidate ?? "") || candidate;
      if (!embedUrl || !/soundcloud\.com/i.test(embedUrl)) {
        return fullMatch;
      }
      return iframeTemplate(embedUrl);
    });

  const fixLazyIframes = (input: string) =>
    input.replace(/<iframe\b([^>]*)>/gi, (iframeMatch, attrs) => {
      const srcMatch = attrs.match(/\bsrc=["']([^"']*)["']/i);
      const hasSrc = Boolean(srcMatch?.[1]);
      const currentSrc = srcMatch?.[1];
      const dataSrcMatch = attrs.match(/\bdata-[\w-]*src=["']([^"']+)["']/i);
      const dataSrc = dataSrcMatch?.[1];
      const embedUrl = findEmbedUrl(attrs) || (dataSrc ? resolveEmbedUrl(dataSrc) ?? dataSrc : null);

      if (!hasSrc && embedUrl) {
        return `<iframe src="${embedUrl}"${attrs.replace(dataSrcMatch?.[0] ?? "", "").replace(/\s?src=["'][^"']*["']/, "")}>`;
      }

      if (hasSrc && currentSrc && embedUrl && (currentSrc.startsWith("data:") || currentSrc.startsWith("about:blank"))) {
        return `<iframe src="${embedUrl}"${attrs.replace(dataSrcMatch?.[0] ?? "", "")}>`;
      }

      return `<iframe${attrs}>`;
    });

  const unwrapNoscriptIframes = (input: string) =>
    input.replace(/<noscript>\s*(<iframe[\s\S]*?<\/iframe>)\s*<\/noscript>/gi, (_full, iframe) => iframe);

  const dedupeAdjacentIframes = (input: string) => {
    const regex =
      /(<div[^>]*wp-block-embed__wrapper[^>]*>\s*)?<iframe\b[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>(\s*<\/div>)?/gi;
    const seen = new Map<string, number>();
    let output = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(input)) !== null) {
      const [fullMatch, , src] = match;
      const start = match.index;
      const end = regex.lastIndex;
      const previousIndex = seen.get(src);
      const isDuplicate = previousIndex !== undefined && start - previousIndex < 2000;

      if (isDuplicate) {
        output += input.slice(lastIndex, start);
        lastIndex = end;
        continue;
      }

      seen.set(src, start);
    }

    output += input.slice(lastIndex);
    return output;
  };

  const dedupeByVideoId = (input: string) => {
    const regex = /<iframe\b[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>/gi;
    const seen = new Set<string>();
    let output = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(input)) !== null) {
      const src = match[1];
      const key = extractYoutubeId(src) ?? src;
      const start = match.index;
      const end = regex.lastIndex;

      if (seen.has(key)) {
        output += input.slice(lastIndex, start);
        lastIndex = end;
        continue;
      }

      seen.add(key);
    }

    output += input.slice(lastIndex);
    return output;
  };

  return unwrapNoscriptIframes(
    dedupeByVideoId(
      dedupeAdjacentIframes(
        fixLazyIframes(
          convertSoundcloudIframes(
            convertLazyYoutubeDivs(
              convertElementskitVideoLinks(
                convertElementorPlaceholders(
                  convertBareLinks(
                    convertParagraphLinks(
                    convertBlockquotes(
                      convertWpFigures(html)
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  );
};

const resolveCategoryPresentation = (
  category: WpCategory | undefined
): CategoryPresentation => {
  if (!category) {
    return DEFAULT_CATEGORY_PRESENTATION;
  }

  return {
    ...DEFAULT_CATEGORY_PRESENTATION,
    ...CATEGORY_PRESENTATION[category.slug],
  };
};

const mapCategory = (category: WpCategory | undefined): BlogCategoryInfo => {
  if (!category) {
    return {
      id: 0,
      slug: "blog",
      name: CATEGORY_PRESENTATION.blog?.name ?? "Blog",
      description:
        CATEGORY_PRESENTATION.blog?.description ??
        DEFAULT_CATEGORY_PRESENTATION.description,
      icon: CATEGORY_PRESENTATION.blog?.icon ?? DEFAULT_CATEGORY_PRESENTATION.icon,
      color:
        CATEGORY_PRESENTATION.blog?.color ?? DEFAULT_CATEGORY_PRESENTATION.color,
      metaDescription:
        CATEGORY_PRESENTATION.blog?.metaDescription ??
        DEFAULT_CATEGORY_PRESENTATION.metaDescription,
      count: undefined,
    };
  }

  const presentation = resolveCategoryPresentation(category);

  return {
    id: category.id,
    slug: category.slug,
    name: presentation.name ?? category.name,
    description: presentation.description ?? category.description,
    icon: presentation.icon ?? DEFAULT_CATEGORY_PRESENTATION.icon,
    color: presentation.color ?? DEFAULT_CATEGORY_PRESENTATION.color,
    metaDescription:
      presentation.metaDescription ??
      category.yoast_head_json?.description ??
      DEFAULT_CATEGORY_PRESENTATION.metaDescription,
    count: category.count,
  };
};

const extractPrimaryCategory = (post: WpPost): WpCategory | undefined => {
  const embeddedTerms = post._embedded?.["wp:term"] ?? [];

  for (const termGroup of embeddedTerms) {
    const category = termGroup.find((term) => term.taxonomy === "category");
    if (category) {
      return category;
    }
  }

  return undefined;
};

const extractFeaturedImage = (post: WpPost): FeaturedImage | null => {
  const media = post._embedded?.["wp:featuredmedia"]?.[0];
  if (media && media.source_url) {
    return {
      src: media.media_details?.sizes?.medium_large?.source_url ?? media.source_url,
      alt: media.alt_text || media.slug || stripHtml(post.title.rendered),
    };
  }

  const firstImageMatch = post.content.rendered.match(/<img[^>]*>/i);
  if (firstImageMatch) {
    const imgTag = firstImageMatch[0];
    const getAttr = (name: string) => {
      const attrRegex = new RegExp(`${name}=["']([^"']+)["']`, "i");
      return attrRegex.exec(imgTag)?.[1];
    };

    const extractFromSrcset = (value?: string | null) => {
      if (!value) return undefined;
      const firstCandidate = value.split(",")[0]?.trim();
      return firstCandidate?.split(" ")[0];
    };

    const dataSrc = getAttr("data-src") ?? getAttr("data-lazy-src");
    const dataSrcset = extractFromSrcset(getAttr("data-srcset") ?? getAttr("data-lazy-srcset"));
    const srcset = extractFromSrcset(getAttr("srcset"));
    const rawSrc = getAttr("src");

    let resolvedSrc = dataSrc || dataSrcset || srcset || rawSrc || undefined;

    // Ignore placeholder gifs from lazy-loading when possible
    if (resolvedSrc && resolvedSrc.startsWith("data:image")) {
      resolvedSrc = dataSrc || dataSrcset || srcset || undefined;
    }

    if (resolvedSrc) {
      return {
        src: resolvedSrc,
        alt: getAttr("alt") || stripHtml(post.title.rendered),
      };
    }
  }

  return null;
};

const extractLeadImage = (html: string): BlogLeadImage | null => {
  const firstImageMatch = html.match(/<img[^>]*>/i);
  if (!firstImageMatch) {
    return null;
  }

  const imgTag = firstImageMatch[0];
  const getAttr = (name: string) => {
    const attrRegex = new RegExp(`${name}=["']([^"']+)["']`, "i");
    return attrRegex.exec(imgTag)?.[1];
  };

  const extractFromSrcset = (value?: string | null) => {
    if (!value) return undefined;
    const firstCandidate = value.split(",")[0]?.trim();
    return firstCandidate?.split(" ")[0];
  };

  const dataSrc = getAttr("data-src") ?? getAttr("data-lazy-src") ?? getAttr("data-original") ?? getAttr("data-url");
  const dataSrcset = extractFromSrcset(getAttr("data-srcset") ?? getAttr("data-lazy-srcset"));
  const srcsetCandidate = extractFromSrcset(getAttr("srcset"));
  const rawSrc = getAttr("src");

  let resolvedSrc = dataSrc || dataSrcset || srcsetCandidate || rawSrc || undefined;
  if (resolvedSrc && resolvedSrc.startsWith("data:image")) {
    resolvedSrc = dataSrcset || srcsetCandidate || undefined;
  }

  if (!resolvedSrc) {
    return null;
  }

  return {
    src: resolvedSrc,
    alt: getAttr("alt"),
  };
};

const removeFirstImage = (html: string): string => {
  let removed = false;
  return html.replace(/<img[^>]*>(?:\s*<\/figure>)?/i, (tag) => {
    if (removed) {
      return tag;
    }
    removed = true;
    return "";
  });
};

const mapPostSummary = (post: WpPost): BlogPostSummary => {
  const category = extractPrimaryCategory(post);
  const categoryInfo = mapCategory(category);
  const excerptHtml =
    convertEmbedsToIframes(
      normalizeLazyImages(
        post.excerpt.rendered ||
        post.yoast_head_json?.description ||
        post.yoast_head_json?.og_description ||
        post.content.rendered.slice(0, 280)
      )
    );
  const excerptText = stripHtml(excerptHtml);

  return {
    id: post.id,
    slug: post.slug,
    title: stripHtml(post.title.rendered) || post.title.rendered,
    excerptHtml,
    excerptText,
    dateIso: post.date,
    dateFormatted: formatDate(post.date),
    readTime: calculateReadTime(post.content.rendered),
    category: categoryInfo,
    featuredImage: extractFeaturedImage(post),
    canonicalUrl: post.link,
  };
};

const mapPostDetails = (post: WpPost): BlogPostDetails => {
  const summary = mapPostSummary(post);
  const author = post._embedded?.author?.[0];
  const normalizedContent = normalizeLazyImages(post.content.rendered);
  const leadImage = extractLeadImage(normalizedContent);
  const contentWithoutLead = leadImage ? removeFirstImage(normalizedContent) : normalizedContent;
  const contentWithEmbeds = convertEmbedsToIframes(contentWithoutLead);

  return {
    ...summary,
    contentHtml: contentWithEmbeds,
    leadImage,
    metaDescription:
      post.yoast_head_json?.description ||
      post.yoast_head_json?.og_description ||
      summary.excerptText,
    yoast: post.yoast_head_json,
    author: {
      name: author?.name ?? "Box Entertainment",
      bio: author?.description,
      avatarUrl: author?.avatar_urls?.["96"],
      role: undefined,
    },
  };
};

export const getBlogPosts = async (
  params: BlogPostsQueryParams
): Promise<BlogPostsResult> => {
  const { items, total, totalPages } = await fetchPosts({
    page: params.page,
    perPage: params.perPage,
    categories: params.categoryId,
    excludeSticky: true,
  });

  return {
    items: items.map(mapPostSummary),
    total,
    totalPages,
  };
};

export const getBlogPostDetails = async (
  slug: string
): Promise<BlogPostDetailsResult | null> => {
  const post = await fetchPostBySlug(slug);
  if (!post) {
    return null;
  }

  const detail = mapPostDetails(post);
  const categoryId = extractPrimaryCategory(post)?.id;

  if (!categoryId) {
    return {
      post: detail,
      previousPost: null,
      nextPost: null,
      relatedPosts: [],
    };
  }

  const { items } = await fetchPosts({
    categories: categoryId,
    perPage: 100,
    excludeSticky: true,
  });

  const siblings = items.map(mapPostSummary);
  const sorted = siblings.sort(
    (a, b) => new Date(b.dateIso).getTime() - new Date(a.dateIso).getTime()
  );
  const currentIndex = sorted.findIndex((item) => item.id === detail.id);

  const previousPost = currentIndex > 0 ? sorted[currentIndex - 1] : null;
  const nextPost =
    currentIndex !== -1 && currentIndex < sorted.length - 1
      ? sorted[currentIndex + 1]
      : null;
  const relatedPosts = sorted.filter((item) => item.id !== detail.id).slice(0, 3);

  return {
    post: detail,
    previousPost,
    nextPost,
    relatedPosts,
  };
};

export const getBlogCategories = async (): Promise<BlogCategoryInfo[]> => {
  const categories = await fetchCategories();

  return categories
    .map((category) => mapCategory(category))
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
};

export const useBlogPosts = (
  params: BlogPostsQueryParams,
  options?: { enabled?: boolean }
) => {
  const queryParams = useMemo(
    () => ({
      page: params.page ?? 1,
      perPage: params.perPage ?? 6,
      categoryId: params.categoryId,
    }),
    [params.page, params.perPage, params.categoryId]
  );

  return useQuery<BlogPostsResult>({
    queryKey: ["blogPosts", queryParams],
    queryFn: () => getBlogPosts(queryParams),
    placeholderData: (previousData) => previousData,
    enabled: options?.enabled ?? true,
  });
};

export const useBlogPost = (slug: string | undefined) =>
  useQuery<BlogPostDetailsResult | null>({
    queryKey: ["blogPost", slug],
    queryFn: () => (slug ? getBlogPostDetails(slug) : Promise.resolve(null)),
    enabled: Boolean(slug),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

export const useBlogCategories = () =>
  useQuery<BlogCategoryInfo[]>({
    queryKey: ["blogCategories"],
    queryFn: getBlogCategories,
  });
