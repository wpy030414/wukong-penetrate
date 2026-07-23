/**
 * SearchProvider — 乙路「网关自封搜索」的引擎抽象。
 *
 * 背景：甲路（deap enable_search）已实测失败——deap 不透传，dingtalk-auto 纯离线。
 * 乙路改由网关自己执行搜索：拦截客户端 web_search → 调本 provider → 由 adapter
 * 伪造 Anthropic 的 server_tool_use + web_search_tool_result 块返回，并把结果作为
 * tool_result 喂回 deap 让模型续写。
 *
 * 当前实现：BingWebSearchProvider —— 抓 cn.bing.com 网页版（无 key 免费），cheerio
 * 解析 li.b_algo 结果块。已实测可爬（200 + 10 结果/页），但存在反爬/改版风险，
 * 失败统一兜底为返回空数组（adapter 层把空结果当「搜索无结果」继续生成，不崩）。
 */

import { load } from 'cheerio';
import { settings } from './config';

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchHit[]>;
}

/** 主流桌面 Chrome UA，规避 Bing 对非浏览器请求的轻量反爬。 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Bing 结果块里的资源类 href 噪声（实测：每个 b_algo 前面塞一串 css/js link）。 */
const RESOURCE_HREF = /r\.bing\.com\/rs\/|\/rp\/|\.css$|\.js$|bing\.com\/ACJ/i;

/**
 * cn.bing.com 网页版搜索 provider。
 * 结构（已实测 dump）：每个 <li class="b_algo"> 内 <h2><a href="真实URL">标题</a></h2>，
 * 摘要在 .b_caption p 或 p.b_lineclamp。前面的一堆 <link rel=stylesheet> 是噪声，靠
 * 「只在 h2 a 取 href + RESOURCE_HREF 过滤」规避。
 */
export class BingWebSearchProvider implements SearchProvider {
  async search(query: string): Promise<SearchHit[]> {
    const url =
      `https://${settings.bingWebHost}/search?q=${encodeURIComponent(query)}` +
      `&count=${settings.searchMaxResults * 2}&setlang=${settings.bingWebLocale}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept-Language': `${settings.bingWebLocale},${settings.bingWebLocale.split('-')[0]};q=0.9`,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(settings.searchTimeoutMs),
      });
    } catch {
      return []; // 网络/超时兜底
    }
    if (!res.ok) return [];

    const $ = load(await res.text());
    const hits: SearchHit[] = [];
    $('li.b_algo').each((_, el) => {
      if (hits.length >= settings.searchMaxResults) return false;
      const $el = $(el);
      const $a = $el.find('h2 a').first();
      const u = $a.attr('href') || '';
      if (!/^https?:\/\//i.test(u) || RESOURCE_HREF.test(u)) return;
      const title = $a.text().trim();
      const snippet = $el.find('.b_caption p, p.b_lineclamp').first().text().trim();
      if (title && u) hits.push({ url: u, title, snippet });
    });
    return hits;
  }
}

/** 按配置返回搜索 provider；searchEngine='off' 或未知时返回 null（乙路关闭）。 */
export function getSearchProvider(): SearchProvider | null {
  switch (settings.searchEngine) {
    case 'bing-web':
      return new BingWebSearchProvider();
    default:
      return null;
  }
}
