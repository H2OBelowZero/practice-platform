// Public-site content in one place. Everything marked PLACEHOLDER is stand-in text for the practice to replace before launch.

export const SITE = {
  practitioner: "Dr. Nkala",
  phone: "+27 11 481 5838",
  phoneHref: "tel:+27114815838",
  email: "zusiphenkala13@gmail.com",
  location: "58 6th St, Randburg, 2193",
  street: "58 6th St",
  locality: "Randburg",
  postalCode: "2193",
  hours: "Monday to Friday, 08:00 to 17:00", // PLACEHOLDER
  registration: "HPCSA registration no. [000 0000] · Practice no. [000 0000]", // PLACEHOLDER
};

/** True once a SITE value has been replaced with real practice details (placeholders hold brackets, example.com or all-zero digits). */
export const isReal = (v: string) => !/\[|example\.com|0000/.test(v);

/** Practice name: full form for structured data and share cards, short form and tagline for the wordmark and page titles. */
export const BRAND = "Dr. Nkala Psychology and Consulting Practice";
export const BRAND_SHORT = "Dr. Nkala";
export const BRAND_TAGLINE = "Psychology and consulting practice";

/** The Gauteng catchment the site targets. Used in titles, copy and the LocalBusiness areaServed. */
export const SERVICE_AREAS = ["Randburg", "Johannesburg", "Sandton", "Rosebank", "Bryanston", "Fourways", "Midrand"] as const;

/** Blog posts carry placeholder body text. While false they are noindex and left out of the sitemap, so thin duplicate pages never reach Google. Set true when real articles replace POST_BODY. */
export const POSTS_PUBLISHED = false;

/** Canonical origin, no trailing slash: APP_URL once the domain is set, else Vercel's production host, else localhost. */
export function siteUrl(): string {
  const url = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
  return url.replace(/\/+$/, "");
}

export const NAV = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/practices", label: "Practices" },
  { href: "/blog", label: "Blog" },
  { href: "/contact", label: "Contact" },
] as const;

export const AREAS = [
  { slug: "trauma-and-stress", title: "Trauma and stress", short: "Making sense of experiences that still echo, at a pace your body can hold.",
    long: "Difficult events can stay close long after they end. Together we work gently towards understanding what happened and what it left behind, so the past stops deciding the present. Nothing is rushed, and you stay in charge of how far we go each session." },
  { slug: "anxiety-and-wellbeing", title: "Anxiety and emotional wellbeing", short: "Steadier days, quieter nights and a kinder inner voice.",
    long: "Worry, low mood and constant tension are signals worth listening to. We look at what they are protecting you from, build practical tools for the hard moments, and make room for the emotions you have been holding at arm’s length." },
  { slug: "relationships-and-attachment", title: "Relationships and attachment", short: "Understanding the patterns you bring to the people closest to you.",
    long: "The way we love, trust and protect ourselves was learned early. Therapy gives you a place to notice those patterns, grieve what they cost, and practise new ways of staying close to people without losing yourself." },
  { slug: "identity-and-belonging", title: "Identity and belonging", short: "Space to explore who you are, where you come from and where you fit.",
    long: "Culture, family, faith, language and community shape every one of us. Whether you are questioning, reconnecting or carrying the weight of not fitting in, your story is welcome here in full." },
  { slug: "life-transitions", title: "Life transitions", short: "Support through the changes that ask you to become someone new.",
    long: "New roles, endings, moves and milestones can unsettle even the changes we chose. We slow things down, name what is being lost and gained, and help you step forward with intention." },
  { slug: "major-life-disruptions", title: "Major life disruptions", short: "Steadying yourself after loss, crisis or sudden upheaval.",
    long: "When life changes overnight, ordinary coping often is not enough. Therapy offers steady, practical support while you find your footing, and a witness to what you are going through." },
] as const;

export const STAGES = [
  { title: "What happened", text: "We start by listening. Your history is not a problem to be fixed but a story to be understood, at a pace that feels safe, with nothing you are expected to relive." },
  { title: "What is happening", text: "Understanding becomes steadier ground. You learn to recognise how the past shows up in your body, your relationships and your choices today, and to respond differently." },
  { title: "What happens next", text: "With the weight of the past held more lightly, there is room to decide. We turn towards the life you want and the person you are becoming." },
] as const;

export const FAQ = [
  { q: "What happens in a first session?", a: "We talk about what brought you here, what you hope will change, and how therapy works. There is no pressure to share more than you want to, and you decide at the end whether we are a good fit." },
  { q: "Do you offer sessions online?", a: "Session formats, such as in person or online, are shown when you book. Choose whichever suits you best." },
  { q: "Can I claim from my medical aid?", a: "Many clients can. Fees and claiming arrangements are explained at booking, and invoices are sent through your secure portal so you can submit them to your medical aid." },
  { q: "What if I need to cancel or reschedule?", a: "You can cancel or reschedule from your portal. The cancellation window and any late-cancellation fee are shown clearly before you confirm a booking." },
  { q: "Is what I say confidential?", a: "Yes. What you share stays between us, within the limits of the law and professional ethics, which we go through together at the start. Your records are kept in a private, access-controlled system." },
] as const;

export type Post = { slug: string; title: string; excerpt: string; category: string; date: string; read: string };

export const POSTS: Post[] = [
  { slug: "why-looking-back-helps", title: "Why looking back can help you move forward", excerpt: "Revisiting the past is not the same as living in it. Here is how reflection becomes a route to change.", category: "Healing", date: "2026-10-14", read: "5 min read" },
  { slug: "what-trauma-informed-means", title: "What “trauma-informed” therapy actually means", excerpt: "A plain-language guide to safety, choice and pacing, and why they matter more than any technique.", category: "Trauma", date: "2026-09-30", read: "6 min read" },
  { slug: "anxiety-in-the-body", title: "Anxiety lives in the body, not only the mind", excerpt: "Small, practical ways to settle your nervous system on the days thinking your way out does not work.", category: "Wellbeing", date: "2026-09-12", read: "4 min read" },
  { slug: "belonging-and-identity", title: "Belonging: the quiet question behind many first sessions", excerpt: "On culture, family expectations and the search for a place where you do not have to explain yourself.", category: "Identity", date: "2026-08-27", read: "7 min read" },
  { slug: "preparing-for-first-session", title: "How to prepare for your first therapy session", excerpt: "What to bring, what to expect and how to make the first hour feel less daunting.", category: "Getting started", date: "2026-08-05", read: "3 min read" },
];

/** Placeholder article body, shared by every post until real articles are written. */
export const POST_BODY = [
  "This is placeholder article text. Replace it with the full post once it is written. Short paragraphs, plain language and one idea at a time read best on any screen.",
  "A strong article opens with a moment the reader will recognise, explains what is going on in everyday terms, and closes with one small, doable next step rather than a long list of advice.",
  "If something in this article stirred up difficult feelings, you do not have to work through them alone. Reaching out to book a consultation is a good first step.",
];

export const dateLabel = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
