import type { GetServerSideProps } from 'next';
import Head from 'next/head';

// Эта страница — лендинг для рекламы Платона (Google Ads), не часть
// основного бот-функционала. Она рендерится только когда деплой сконфигурирован
// под MASTER_PROFILE=platon (отдельный Vercel-проект Платона), чтобы контент
// одного мастера не попал в деплой другого. На любом другом деплое "/" отдаёт
// простую нейтральную страницу 200, а не 404 (которую не принимает Google Ads),
// но без рекламных обещаний.
const BOT_USERNAME = 'inka_ps_bot'; // подтверждено Анной 2026-11-20
const INSTAGRAM_URL = 'https://www.instagram.com/platon_tattoo__/';

// Карусель работ. Реальные фото класть в public/gallery/ и менять src ниже
// (сейчас — SVG-плейсхолдеры). Портрет 4:5, ~800×1000.
const GALLERY: { src: string; alt: string }[] = [1, 2, 3, 4, 5, 6].map((n) => ({
  src: `/gallery/work-${n}.svg`,
  alt: `Platon Sosnitsky tattoo work ${n}`,
}));

type Props = { isPlaton: boolean };

export const getServerSideProps: GetServerSideProps<Props> = async () => {
  const id = (process.env.MASTER_PROFILE ?? process.env.PRICING_PROFILE ?? '').trim().toLowerCase();
  return { props: { isPlaton: id === 'platon' } };
};

function FallbackPage() {
  return (
    <>
      <Head>
        <title>Inka</title>
        <meta name="robots" content="noindex" />
      </Head>
      <main style={{ fontFamily: 'sans-serif', padding: 24 }}>
        <p>OK</p>
      </main>
    </>
  );
}

export default function Home({ isPlaton }: Props) {
  if (!isPlaton) return <FallbackPage />;

  const copy = {
    he: {
      dir: 'rtl',
      lang: 'he',
      title: 'אמנות Blackwork, Blackout וכיסוי קעקועים מורכבים',
      subtitle:
        'סטודיו פרטי ודיסקרטי בחיפה (55 דק׳ ברכבת מתל אביב). פרויקטים גדולים בהתאמה אישית לאנטומיה של הגוף, סשנים מרוכזים באווירה שקטה ללא הסחות דעת.',
      ctaProject: 'תכנון פרויקט חדש בבוט (Telegram)',
      ctaProjectLink: `https://t.me/${BOT_USERNAME}?start=he_project`,
      ctaCoverup: 'בדיקת כיסוי קעקוע ישן (Cover-Up)',
      ctaCoverupLink: `https://t.me/${BOT_USERNAME}?start=he_coverup`,
      altText: `אין לך טלגרם? אפשר לראות עבודות ולשלוח הודעה ישירה דרך <a href="${INSTAGRAM_URL}" target="_blank" rel="noopener">Instagram</a>`,
      stepsTitle: 'איך מתקדמים מכאן?',
      step1: '1. בוחרים את סוג הפרויקט ועוברים לשיחה קצרה עם העוזר הדיגיטלי בטלגרם.',
      step2: '2. מצרפים תיאור, מיקום בגוף או תמונה של הקעקוע הקיים (במקרה של כיסוי).',
      step3: '3. מקבלים התייחסות אישית, הערכת היקף סשנים ותיאום תאריך בסטודיו.',
    },
    en: {
      dir: 'ltr',
      lang: 'en',
      title: 'Custom Blackwork, Blackout & Complex Cover-Up Projects',
      subtitle:
        'Private appointment-only studio in Haifa (55 min by train from Tel Aviv). Large-scale projects tailored to body anatomy in a calm, 1-on-1 atmosphere.',
      ctaProject: 'Discuss a New Project in Telegram Bot',
      ctaProjectLink: `https://t.me/${BOT_USERNAME}?start=en_project`,
      ctaCoverup: 'Evaluate a Tattoo Cover-Up in Bot',
      ctaCoverupLink: `https://t.me/${BOT_USERNAME}?start=en_coverup`,
      altText: `No Telegram? View portfolio & message directly on <a href="${INSTAGRAM_URL}" target="_blank" rel="noopener">Instagram</a>`,
      stepsTitle: 'How it works',
      step1: '1. Choose your project type to open a quick guided chat in Telegram.',
      step2: '2. Share your idea, placement, or a photo of the existing tattoo for cover-up.',
      step3: '3. Receive personal feedback, session estimate, and available studio dates.',
    },
  };

  return (
    <>
      <Head>
        <title>Platon Sosnitsky — Private Tattoo Studio | Blackwork, Blackout & Cover-Up</title>
        <meta
          name="description"
          content="Private tattoo studio in Haifa. Large-scale Blackwork, Blackout, Abstract & complex Cover-Up projects. Full-day custom sessions."
        />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {/* Google Ads conversion ("Переход в бота Platon" — Anna, 2026-11-22):
            загружаем настоящий gtag.js для AW-18586351280 напрямую, а не
            полагаемся на тег внутри GTM-контейнера — в опубликованной версии
            GTM-WTZK4P2W такого тега/триггера нет (проверено по живому
            gtm.js), и настроить его там некому без доступа в кабинет. Этот
            способ работает независимо от GTM и ничего там не требует. */}
        <script async src="https://www.googletagmanager.com/gtag/js?id=AW-18586351280" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.dataLayer = window.dataLayer || [];
              function gtag(){dataLayer.push(arguments);}
              gtag('js', new Date());
              gtag('config', 'AW-18586351280');
            `,
          }}
        />
        {/* Google Tag Manager — container GTM-WTZK4P2W (Anna, 2026-11-20).
            Оставлен как есть: аккаунт AW-18586351280 к нему уже привязан
            отдельно, но конверсия выше идёт напрямую через gtag.js. */}
        <script async src="https://www.googletagmanager.com/gtm.js?id=GTM-WTZK4P2W" />
      </Head>
      {/* GTM noscript fallback — стандартная часть установки, идёт сразу после <body>. */}
      <noscript>
        <iframe
          src="https://www.googletagmanager.com/ns.html?id=GTM-WTZK4P2W"
          height="0"
          width="0"
          style={{ display: 'none', visibility: 'hidden' }}
        />
      </noscript>
      <style>{`
        :root {
          --bg: #0c0c0d;
          --card: #151517;
          --border: #27272a;
          --text: #f4f4f5;
          --muted: #a1a1aa;
          --accent: #ffffff;
          --accent-text: #09090b;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background-color: var(--bg);
          color: var(--text);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          line-height: 1.5;
        }
        .container { max-width: 540px; width: 100%; margin: 0 auto; }
        header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 36px; }
        .brand { font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
        .lang-switch { display: flex; gap: 8px; }
        .lang-btn {
          background: transparent; border: 1px solid var(--border); color: var(--muted);
          padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; transition: all 0.2s;
        }
        .lang-btn.active { border-color: var(--accent); color: var(--accent); }
        h1 { font-size: 28px; font-weight: 600; line-height: 1.25; margin-bottom: 14px; letter-spacing: -0.02em; }
        .subtitle { color: var(--muted); font-size: 15px; margin-bottom: 28px; }
        .tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 32px; }
        .tag { background: var(--card); border: 1px solid var(--border); padding: 6px 12px; border-radius: 999px; font-size: 13px; color: var(--text); }
        .cta-group { display: flex; flex-direction: column; gap: 12px; margin-bottom: 28px; }
        .btn-primary {
          display: flex; align-items: center; justify-content: center; background: var(--accent); color: var(--accent-text);
          text-decoration: none; font-weight: 600; font-size: 16px; padding: 16px 20px; border-radius: 10px; transition: opacity 0.2s;
        }
        .btn-primary:hover { opacity: 0.9; }
        .btn-secondary {
          display: flex; align-items: center; justify-content: center; background: var(--card); color: var(--text);
          border: 1px solid var(--border); text-decoration: none; font-weight: 500; font-size: 15px; padding: 15px 20px;
          border-radius: 10px; transition: border-color 0.2s;
        }
        .btn-secondary:hover { border-color: var(--muted); }
        .alt-contact { text-align: center; font-size: 13px; color: var(--muted); margin-bottom: 36px; }
        .alt-contact a { color: var(--text); text-decoration: underline; }
        .gallery { position: relative; margin-bottom: 32px; direction: ltr; }
        .gallery-track {
          display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x mandatory;
          scrollbar-width: none; -webkit-overflow-scrolling: touch;
        }
        .gallery-track::-webkit-scrollbar { display: none; }
        .gallery-item {
          flex: 0 0 72%; scroll-snap-align: center; aspect-ratio: 4 / 5; border-radius: 12px;
          overflow: hidden; background: var(--card); border: 1px solid var(--border);
        }
        .gallery-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .gallery-nav {
          position: absolute; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; border-radius: 50%;
          border: 1px solid var(--border); background: rgba(12,12,13,0.7); color: var(--text); font-size: 18px; cursor: pointer;
        }
        .gallery-nav.prev { left: 6px; }
        .gallery-nav.next { right: 6px; }
        @media (hover: none) { .gallery-nav { display: none; } }
        .steps { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 32px; }
        .steps-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: var(--text); }
        .step-item { font-size: 14px; color: var(--muted); margin-bottom: 8px; }
        .step-item:last-child { margin-bottom: 0; }
        footer {
          max-width: 540px; width: 100%; margin: 0 auto; padding-top: 20px; border-top: 1px solid var(--border);
          font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 6px;
        }
        footer a { color: var(--muted); text-decoration: underline; }
        .page-wrap { min-height: 100vh; display: flex; flex-direction: column; justify-content: space-between; padding: 24px 16px; }
      `}</style>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            // Один action в Google Ads ("Переход в бота Platon") — срабатывает
            // при клике на любую из двух кнопок перехода в Telegram-бот.
            // Ссылка на Instagram (запасной канал, не бот) эту конверсию не шлёт.
            function trackBotConversion() {
              if (typeof gtag === 'function') {
                gtag('event', 'conversion', { 'send_to': 'AW-18586351280/UplHCLGHmbwdELDt1J5F' });
              }
            }
          `,
        }}
      />
      <div className="page-wrap" dir="rtl" lang="he">
        <div className="container">
          <header>
            <div className="brand">PLATON SOSNITSKY • STUDIO</div>
            <div className="lang-switch">
              <button id="btn-he" className="lang-btn active" onClick={() => (window as any).__setLang?.('he')}>
                עברית
              </button>
              <button id="btn-en" className="lang-btn" onClick={() => (window as any).__setLang?.('en')}>
                English
              </button>
            </div>
          </header>

          <main>
            <h1 id="title">{copy.he.title}</h1>
            <p id="subtitle" className="subtitle">
              {copy.he.subtitle}
            </p>

            <div className="tags">
              <span className="tag">Blackwork</span>
              <span className="tag">Blackout</span>
              <span className="tag">Abstract</span>
              <span className="tag">Full Body</span>
              <span className="tag">Complex Cover-Up</span>
            </div>

            <div className="cta-group">
              <a
                id="cta-project"
                href={copy.he.ctaProjectLink}
                target="_blank"
                rel="noopener"
                className="btn-primary"
                onClick={() => (window as any).trackBotConversion?.()}
              >
                {copy.he.ctaProject}
              </a>
              <a
                id="cta-coverup"
                href={copy.he.ctaCoverupLink}
                target="_blank"
                rel="noopener"
                className="btn-secondary"
                onClick={() => (window as any).trackBotConversion?.()}
              >
                {copy.he.ctaCoverup}
              </a>
            </div>

            <p
              id="alt-text"
              className="alt-contact"
              dangerouslySetInnerHTML={{ __html: copy.he.altText }}
            />

            <div className="gallery" id="gallery" aria-roledescription="carousel" aria-label="Tattoo works">
              <div className="gallery-track" id="gallery-track">
                {GALLERY.map((g, i) => (
                  <div className="gallery-item" key={g.src}>
                    <img src={g.src} alt={g.alt} loading={i === 0 ? 'eager' : 'lazy'} decoding="async" width={800} height={1000} />
                  </div>
                ))}
              </div>
              <button type="button" className="gallery-nav prev" aria-label="Previous" onClick={() => (window as any).__galleryGo?.(-1)}>
                ‹
              </button>
              <button type="button" className="gallery-nav next" aria-label="Next" onClick={() => (window as any).__galleryGo?.(1)}>
                ›
              </button>
            </div>

            <div className="steps">
              <div id="steps-title" className="steps-title">
                {copy.he.stepsTitle}
              </div>
              <div id="step-1" className="step-item">
                {copy.he.step1}
              </div>
              <div id="step-2" className="step-item">
                {copy.he.step2}
              </div>
              <div id="step-3" className="step-item">
                {copy.he.step3}
              </div>
            </div>
          </main>
        </div>

        <footer>
          <div id="footer-loc">Haifa, Israel • Private Appointment-Only Studio</div>
          <div id="footer-privacy">
            <a href="/privacy">Privacy Policy</a>
          </div>
        </footer>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            var copy = ${JSON.stringify(copy)};
            function setLang(l) {
              var c = copy[l];
              document.documentElement.dir = c.dir;
              document.documentElement.lang = c.lang;
              document.getElementById('title').textContent = c.title;
              document.getElementById('subtitle').textContent = c.subtitle;
              var pBtn = document.getElementById('cta-project');
              pBtn.textContent = c.ctaProject;
              pBtn.href = c.ctaProjectLink;
              var cBtn = document.getElementById('cta-coverup');
              cBtn.textContent = c.ctaCoverup;
              cBtn.href = c.ctaCoverupLink;
              document.getElementById('alt-text').innerHTML = c.altText;
              document.getElementById('steps-title').textContent = c.stepsTitle;
              document.getElementById('step-1').textContent = c.step1;
              document.getElementById('step-2').textContent = c.step2;
              document.getElementById('step-3').textContent = c.step3;
              document.getElementById('btn-he').classList.toggle('active', l === 'he');
              document.getElementById('btn-en').classList.toggle('active', l === 'en');
            }
            window.__setLang = setLang;
            window.__galleryGo = function (d) {
              var t = document.getElementById('gallery-track');
              if (t) t.scrollBy({ left: d * t.clientWidth * 0.75, behavior: 'smooth' });
            };
            if (new URLSearchParams(window.location.search).get('lang') === 'en') {
              setLang('en');
            }
          `,
        }}
      />
    </>
  );
}
