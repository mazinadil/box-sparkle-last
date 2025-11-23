import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const toAbsolute = (p) => path.resolve(__dirname, '..', p)

const BASE_URL = 'https://boxentertainment.ae'
const WP_API_BASE = process.env.WP_API_BASE || 'https://boxentertainment.ae/wp-json'
const BLOG_LIMIT = Number(process.env.VITE_PRERENDER_BLOG_LIMIT || 100)

export const writeBlogSitemap = async () => {
  try {
    console.log('📝 Fetching blog posts from WordPress API...')
    
    // Fetch blog posts
    const postsUrl = `${WP_API_BASE}/wp/v2/posts?_embed=true&per_page=${BLOG_LIMIT}&orderby=date&order=desc`
    const postsResponse = await fetch(postsUrl)
    
    if (!postsResponse.ok) {
      throw new Error(`WordPress API returned ${postsResponse.status}: ${postsResponse.statusText}`)
    }
    
    const posts = await postsResponse.json()
    
    // Fetch categories
    const categoriesUrl = `${WP_API_BASE}/wp/v2/categories?per_page=100`
    const categoriesResponse = await fetch(categoriesUrl)
    
    if (!categoriesResponse.ok) {
      console.warn('⚠️  Failed to fetch categories, continuing with posts only')
    }
    
    const categories = categoriesResponse.ok ? await categoriesResponse.json() : []
    
    // Generate sitemap entries
    const urls = []
    
    // Add category pages
    if (categories.length > 0) {
      categories.forEach(category => {
        if (category.count > 0) { // Only include categories with posts
          urls.push(`  <url>
    <loc>${BASE_URL}/blog/${category.slug}</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>`)
        }
      })
    }
    
    // Add individual blog posts
    posts.forEach(post => {
      const category = post._embedded?.['wp:term']?.[0]?.[0]
      const categorySlug = category?.slug || 'blog'
      
      // Convert WordPress date to ISO format
      const lastmod = post.modified ? new Date(post.modified).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
      
      urls.push(`  <url>
    <loc>${BASE_URL}/${categorySlug}/${post.slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`)
    })
    
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`

    // Ensure dist directory exists
    const distPath = toAbsolute('dist')
    if (!fs.existsSync(distPath)) {
      fs.mkdirSync(distPath, { recursive: true })
    }

    const outputPath = toAbsolute('dist/sitemap-blog.xml')
    fs.writeFileSync(outputPath, sitemap, 'utf-8')
    
    const stats = fs.statSync(outputPath)
    console.log(`✓ Generated sitemap-blog.xml (${categories.length} categories, ${posts.length} posts, ${stats.size} bytes)`)
    
    return true
  } catch (error) {
    console.error('❌ Failed to generate blog sitemap:', error.message)
    console.error('⚠️  Continuing build without blog sitemap')
    
    // Create empty blog sitemap as fallback
    const emptySitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
</urlset>`
    
    const distPath = toAbsolute('dist')
    if (!fs.existsSync(distPath)) {
      fs.mkdirSync(distPath, { recursive: true })
    }
    
    fs.writeFileSync(toAbsolute('dist/sitemap-blog.xml'), emptySitemap, 'utf-8')
    console.log('✓ Created empty blog sitemap as fallback')
    
    return false
  }
}

// Run if called directly
if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  await writeBlogSitemap()
}
