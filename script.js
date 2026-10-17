// THE ARCHIVE — edit this file to personalize the site.
// Replace sample names, captions, quotes, bios, traits and photo URLs before publishing.
const quotes = [
  { text: "Ek goli tumko marunga, ek goli khud ko marunga.", author: "Dr. AK Tiwari" },
  { text: "Rajveer is the most trusted student of the class!", author: "Navi sir" },
  { text: "Divyansh is the best student of the class!", author: "Navi sir" },
  { text: "Jo loop chalana seekh liya, wo KV ka master ban sakta hai.", author: "VP, The Loop" },
  { text: "Sawal thodi mushkil hote hain, jawab mushkil hote hain.", author: "Rupesh sir" },
  { text: "Chor wahi hota hai jo pakda jata hai", author: "Choudhary Ji" },
  { text: "LOVE: Loss of energy, Ocean of tears, Valley of death, End of life.", author: "Dr. AK Tiwari" },
  { text: "\"Maut AA rahi Hai\" 🏃🏻‍♀️", author: "Someone, probably" },
  { text: "Noobda", author: "The Great Divaa" },
  { text: "\"Her name\"", author: "Abdhesh Tiwari" },
  { text: "Hi Bhavya!", author: "Python" }
];

// The 30 entries below are placeholders. Use classmates' consented photos before making the site public.
// Categories: legend, chaos, quiet. The current categories are demo labels, not real judgments.

const studentCategories = {
  "Abdhesh": "scientist",
  "Abhijit": "cid",
  "Adarsh": "cid",
  "Adhyan": "cid",
  "Alok": "gd",
  "Amrit": "gd",
  "Anand": "gd",
  "Anuj": "gd",
  "Aryan": "cid",
  "Bhavya": "eng",
  "Divyansh": "good",
  "Harsh": "scientist",
  "Kanishka": "eng",
  "Kashish": "eng",
  "Khushi": "good",
  "Krishna": "scientist",
  "Mayank": "cid",
  "Ali": "scientist",
  "Muskan": "eng",
  "Nayan": "good",
  "Rajveer": "eng",
  "Rashi": "good",
  "Rishika": "eng",
  "Ruchi": "good",
  "Rushil": "scientist",
  "Saksham": "cid",
  "Samriddhi": "scientist",
  "Shailee": "eng",
  "Sristi": "eng",
  "Uttam": "gd"

};


const studentProfiles = {
  "Abdhesh": {
    caption: "Boy of a girl",
    quote: "Uper aldehyde, neeche ketone.",
    traits: "Leadership, physique, and her name.",
    bio: "Tan pe powder, man me korea. School captain jo ki pradhan mantri se pookie ban gaya :D... Supportive hai, class me kuchh bhi hota hai to hamesha class ke liye aage rhta hai. Have leadership qualities (+ thoda hila hua hai). Sometimes very loud, sometimes dead silent."
  },
  "Abhijit": {
    caption: "The original CID WALA",
    quote: "Chor wahi hota hai jo pakda jata hai.",
    traits: "Chess, Literature",
    bio: "A porcupine who is somehow inhumanly steady without any activity. SIKE! Chat me to Abhijit bhaiya patal me behti lava ki nadi se bhi sticker nikal ke le aate hain."
  },
  "Adarsh": {
    caption: "Dal badlu #2",
    quote: "Solid! Compass bhok denge!!",
    traits: "Football, Dramebaaz",
    bio: "\"(Irritable, clumsy, friendly)\"... Kodhi insaan jo itna bagal me rhke bhi cycle se nahi aa sakta."
  },
  "Adhyan": {
    caption: "アビラル先輩",
    quote: "Padhai likhai dhokha hai, mar jaao abhi mauka hai.",
    traits: "History, Politics, Millitary Information",
    bio: "A mentally resilient person who forgives others kinda eaisly yet does not take stand for himself. Besides, always act happy :)"
  },
  "Alok": {
    caption: "Sports Captain",
    quote: "Sir wo chhoot gaya... hai",
    traits: "Handball, Football, Basketball, Badminton, Funny",
    bio: "Khelne wala GD... Achchha aadmi hai. Always thinks about the wellfare of his friends and never tries to trouble them in any manner. Always humble, never shows off his achievements and skills. Amazing sportsperson! Good GD."
  },
  "Amrit": {
    caption: "The Original GD",
    quote: "FAILURE MEAN NOT YOU BECAME FAIL ",
    traits: "Cricket",
    bio: "The founder of GD Group. Funny guy, amazing in cricket (6 pe 36 😉). He was the original Chinu, even before Anand got Chinu!"
  },
  "Anand": {
    caption: "Self Lover",
    quote: "Bure logo se dhokha khakr aaache logo ke sath galat nhi krte.",
    traits: "Funny, Sensitive, Understanding, Chinu Person",
    bio: "Have special affinity towards commerce despite being a science student. Always been a comedic person, atleast upto class 10th... Improved exponentially in the last two years. Really a fun guy!"
  },
  "Anuj": {
    caption: "Anujaa Kheti",
    quote: "Hud hud dabang dabang..",
    traits: "Mathematics Lover, MMA lover",
    bio: "Partially introvert. Always tried his best to act good with everybody even if the other person teased him a lot! (Our star teacher, iykyk). Despite all the hardships, always saw ahed. A really nice friend to have in the class."
  },
  "Aryan": {
    caption: "Riderr",
    quote: "These are my private parts, don't touch them 🥺",
    traits: "Basketball, Bike",
    bio: "Rajveer's super special friend. Loves filling water bottles in Math class and is effectively the favorite student of Nikita ma'am 😉"
  },
  "Bhavya": {
    caption: "Mera juta 5 number ka hai :D",
    quote: "Koi quote nahi hai. Chup chaap aage badho 🔪",
    traits: "Remembers the entire timetable, Notebook is always complete, Too lazy to wear socks, Wears shoes like slippers",
    bio: "\"(Caring, sweet, supportive, non judgemental)\"... A 'chhoti si bachchi' who always help others and tends to partially sleep in class."
  },
  "Divyansh": {
    caption: "The True Divaa",
    quote: "Uttam noobda",
    traits: "Artist 🎨, Basketball, Cricket, Badminton",
    bio: "A very supportive person who is not at all afraid of saying the truth. Is smart enough to not to get himself in unneccessary trouble and a perfect person to tease :-)"
  },
  "Harsh": {
    caption: "Chashma wala scientist",
    quote: "Man badha kar rakhe hai",
    traits: "Curious, Mathematical, Programming, Football, Basketball",
    bio: "Never complains unnecessarily and continues doing his work. Always supportive towards EVERYBODY and is a very good friend. Always humble and never shows off his knowledge. A very good friend to have in the class."
  },
  "Kanishka": {
    caption: "Sleepy Introvert",
    quote: "Maut aa rahi hai.",
    traits: "English: Accent, Literature, Writing and Dance",
    bio: "Kind hearted, understanding, supportive yet introverted. A person who is always there for her friends yet scared to express herself. A very intresting person to have in the class."
  },
  "Kashish": {
    caption: "Powder",
    quote: "OH HELL NAHH!",
    traits: "Dance, Singing, Acting",
    bio: "A lot of energy is compressed inside a verry small body. A little girl who is... friendly, feisty and ofcourse! SLEEPY! Nice to have her in the class for 12 years straight."
  },
  "Khushi": {
    caption: "Artist",
    quote: "Time nikalna padta hai.",
    traits: "Painting, Creative, Crafts",
    bio: "Kind, helpful, creative and a person who never interfers in others' businesses. Have never denied anybody if she can help them. Chill girl."
  },
  "Krishna": {
    caption: "KRK: The Python",
    quote: "Ami tuma ke meow meow",
    traits: "Programming, Kemistri (OC), Poetry, Overforgiving",
    bio: "Kind person who is there for his friends and is always ready to help them. Sometimes hurt himself but never shows it. Very lazy. Sometimes sleep too much and sometimes kills sleep. Good guy."
  },
  "Mayank": {
    caption: "Gym Freak",
    quote: "Nahi pta kuchh",
    traits: "Gym Freak, Computer hardware",
    bio: "Achchha aadmi hai. Bina matlab jhagda nahi karta, masti mazak me rhta hai. Shaam ko gym me busy xD. Dil ka achchha hai chahe kitna bhi baklol kyun na ho."
  },
  "Ali": {
    caption: "South ka bachcha",
    quote: "Computer sciente wale hain sir 😎",
    traits: "Kurafaati, Loud, Sleepy, Curious",
    bio: "A student who is loved by everyone, teachers and students alike. The personal favorite of Rupesh sir, Nikita ma'am and Navneet sir. Beloved child of Tiwari ji!"
  },
  "Muskan": {
    caption: "High density explosive",
    quote: "I am the best dancer!",
    traits: "Dance, Courage, Chocolate Lover",
    bio: "A very courageous person, not scared of anybody. Loves to skip meals yet eats lunch before recess 😂. Hates teaching little children. The only goal of her life is to eat chocolates. Yet supportive towards the class."
  },
  "Nayan": {
    caption: "Fluent Criminal",
    quote: "Mere naina",
    traits: "Lunch Eater In Chem, Fluent In Language, Mischievous",
    bio: "Caring towards her friends, yet mischievous and a little naughty. Talkative person, LOVES to eat her lunch in Tiwari Ji's class!"
  },
  "Rajveer": {
    caption: "Sanskarti Balak",
    quote: "Maut aa rhi hai.",
    traits: "Health, Cricket, Football, Basketball, Volleyball, Sprinting",
    bio: "A mischeveous and person who changed himself completely and now stand on a huge moral ground. Changed his body, mindset and his attitude. Knows his priority and is not scared to show his true self anywhere."
  },
  "Rashi": {
    caption: "Smily Face",
    quote: "Mat puchho...",
    traits: "Smiling, Cheerful",
    bio: "Always smiling, cheerful, and fun for her friends. Never loses her smile and always keeps her friends happy!"
  },
  "Rishika": {
    caption: "Dramatic Girl",
    quote: "Marks toh aa he jayega aap bus padhai kro.",
    traits: "Dance (specially Bharatnatyam), Physically Sensitive, Over emotional, Extremely Loud",
    bio: "Weighs less than a grain of rice but has a whale-like anger. Extremely dramatic and loud, kind of her close friends and family. Memorizes stuff instead of understanding them. And annoys Ruchi and Adarsh a lot!"
  },
  "Ruchi": {
    caption: "Raichi",
    quote: "Hard work always brings you what you deserve.",
    traits: "Handball, Sleepy, Clarity, Kindness",
    bio: "Always been the pride of (2015) section A in sports! Somehow is able to manage her sports and academics simultaneously. Very hardworking and yet never boasts about her achievements. A very nice friend to have in the class."
  },
  "Rushil": {
    caption: "Brainrotted Mypopic",
    quote: "Two realities may simultaneously exist.",
    traits: "Curious, Experimental, Creative",
    bio: "Easy to ragebait, really myopic yet never wears specs. A very creative and curious person who is not bound to the conventional syllabus and goes far beyond it."
  },
  "Saksham": {
    caption: "Jordan",
    quote: ".",
    traits: "Cricket, Helpful",
    bio: "Sleepy guy. Always late for school. Yet... helpful. Kabhi madad karne se mana nahi karta."
  },
  "Samriddhi": {
    caption: "The Supportive Topper",
    quote: "",
    traits: "",
    bio: ""
  },
  "Shailee": {
    caption: "Slow and steady :-)",
    quote: "BHAKK!",
    traits: "Clear Speaker, Sleepy, Helpful",
    bio: "Another member of the class' sloth society who just... sleeps on the last bench. Her notebooks are always complete and she never denies to help anybody. Protective towards her friends and a unique person to have in the class."
  },
  "Sristi": {
    caption: "The Nobita Specs",
    quote: "BITM ki Full form bta degiye fir le jaunga trip pe.",
    traits: "Chocolate Eater, Drawing, Crafts, Throw Ball, Kho kho",
    bio: "Honest person who we can trust. Playful yet acts childish-ly. Somewhat sensitive, yet tends to overcome her ongoing hardships and continues to improve herself."
  },
  "Uttam": {
    caption: "Nirdosh Doshi",
    quote: "Noobda",
    traits: "Playful, Smart, Clever",
    bio: "Mast aadmi hai! Hamesha masti me rhta hai, madad karne ke liye aage rhta hai, aur sabko pareshan karte rhta hai. Lekin wo bhi achchha lagta hai 😃. Uttapam betu is a good boy."
  }
};

const students = Array.from({ length: 30 }, (_, index) => {
  const n = index + 1;
  const names = [
    "Abdhesh", "Abhijit", "Adarsh", "Adhyan", "Alok", "Amrit", "Anand", "Anuj", "Aryan", "Bhavya", "Divyansh", "Harsh", "Kanishka", "Kashish", "Khushi", "Krishna", "Mayank", "Ali", "Muskan", "Nayan", "Rajveer", "Rashi", "Rishika", "Ruchi", "Rushil", "Saksham", "Samriddhi", "Shailee", "Sristi", "Uttam"
  ];

  const profile = studentProfiles[names[index]] || {};

  return {
    id: n,
    name: names[index],
    caption: profile.caption || "Class legend",
    quote: `“${profile.quote || "A memorable class moment"}”`,
    traits: profile.traits || "Class memories",
    bio: profile.bio || "A part of our class story.",
    category: studentCategories[names[index]] || "quiet",
    photo: `images/student-${String(n).padStart(2, "0")}.png`
  };
});

const studentList = document.querySelector("#studentList");
const studentSearch = document.querySelector("#studentSearch");
const studentFilter = document.querySelector("#studentFilter");
const studentCount = document.querySelector("#studentCount");

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}


const classViews = [
  {
    type: "opinion",
    title: "Ruchi",
    text: "Ruchi is too pretty and kind hearted! ♥",
    author: "Bhabya",
    image: "vimages/bhabya1.jpeg"
  },
  {
    type: "opinion",
    title: "Samriddhi: The Best Benchmate",
    text: "She has been my benchmate and a good friend for the past two years.",
    author: "Rashi",
    image: ""
  },
  {
    type: "opinion",
    title: "About Rushil",
    text: "He is a 2 dimensional person yet my best companion in the class.",
    author: "Abhijit",
    image: ""
  },
  {
    type: "memory",
    title: "Khushi and Sristi",
    text: "She is always there with me, whether we are studying, talking, laughing, or just doing random things. ..... She is not just my bench mate but also a good friend and gossip maker😁",
    author: "Sristi",
    image: "vimages/sristi1.jpeg"
  },
  {
    type: "memory",
    title: "Basketball 🏀",
    text: "It was the first time in my KV life that when the entire class played together!",
    author: "Krishna",
    image: "vimages/krishna3.jpg" 
  },
  {
    type: "photo",
    title: "Pta Nahi",
    text: "",
    author: "Uttam",
    image: "vimages/uttam1.jpg"
  },
  {
    type: "memory",
    title: "Football, Rupesh Sir...",
    text: "Jab football match hota tha, Jab class me Rupesh sir sabko target krke padhane bolte , Is saal ka teachers day aur uska aftermath , etc etc (a kiss from Mayank)",
    author: "Adhyan",
    image: ""
  },
  {
    type: "opinion",
    title: "Kanishka?",
    text: "She's very sweet, kind hearted, understanding, so cutee, very prettyyy",
    author: "Anonymous",
    image: "" 
  },
  {
    type: "opinion",
    title: "Dear Principal Sir",
    text: "Char chamani gode pr Chowdhary ji mere ……….pe , aage Aap khud smjdar h ",
    author: "Aryan",
    image: ""
  },
  {
    type: "opinion",
    title: "School band nahi hona chahiye ab",
    text: "Usko bahut gussa ata hai. Still her name is my favorite quote!",
    author: "Anonymous",
    image: "" 
  },
  {
    type: "memory",
    title: "Council!",
    text: "Got a chance to be a part of the student council!",
    author: "Krishna",
    image: "vimages/krishna1.jpg" 
  },
  {
    type: "memory",
    title: "Physics Lab!",
    text: "Our experiments in physics lab...",
    author: "Krishna",
    image: "vimages/krishna2.jpg" 
  }
];

function renderClassViews() {
  const viewsGrid = document.querySelector("#viewsGrid");

  if (!viewsGrid) return;

  const icons = {
    opinion: "✦",
    memory: "✳",
    photo: "▧"
  };

  const labels = {
    opinion: "Opinion",
    memory: "Class memory",
    photo: "Photograph"
  };

  viewsGrid.innerHTML = classViews.map(view => {
    const type = ["opinion", "memory", "photo"].includes(view.type)
      ? view.type
      : "memory";

    const imageHTML = view.image
      ? `<img src="${escapeHTML(view.image)}"
          alt="${escapeHTML(view.title)}"
          loading="lazy"
          onerror="this.parentElement.textContent='✳'">`
      : escapeHTML(icons[type]);

    return `
      <article class="class-view-card">
        <div class="view-art ${type}">
          ${imageHTML}
        </div>

        <div class="view-card-content">
          <span class="view-type">${labels[type]}</span>
          <h3>${escapeHTML(view.title)}</h3>
          <p>${escapeHTML(view.text)}</p>
          <span class="view-author">
            Shared by ${escapeHTML(view.author)}
          </span>
        </div>
      </article>
    `;
  }).join("");
}

renderClassViews();


function renderStudents() {
  const term = studentSearch.value.trim().toLowerCase();
  const filter = studentFilter.value;
  const filtered = students.filter(student => {
    const matchesText = [student.name, student.caption, student.quote, student.traits]
      .some(value => value.toLowerCase().includes(term));
    return matchesText && (filter === "all" || student.category === filter);
  });
  studentList.innerHTML = filtered.length ? filtered.map(student => `
    <details class="student-card">
      <summary class="student-summary">
        <img class="student-photo" src="${escapeHTML(student.photo)}" alt="Sample portrait for ${escapeHTML(student.name)}" loading="lazy"
          onerror="this.onerror=null;this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%22240%22 viewBox=%220 0 240 240%22%3E%3Crect width=%22240%22 height=%22240%22 fill=%22%23332b4c%22/%3E%3Ctext x=%2250%25%22 y=%2255%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23d7c8ff%22 font-size=%2260%22 font-family=%22Arial%22%3E${escapeHTML(student.name.charAt(0))}%3C/text%3E%3C/svg%3E'">
        <div class="student-main">
          <span class="student-id">STUDENT ${String(student.id).padStart(2, "0")}</span>
          <h3 class="student-name">${escapeHTML(student.name)}</h3>
          <span class="student-caption">${escapeHTML(student.caption)}</span>
        </div>
        <div class="student-bio student-bio-preview"><p class="student-quote">${escapeHTML(student.quote)}</p><span class="student-traits">${escapeHTML(student.traits)}</span></div>
        <span class="student-tag">${escapeHTML(
    ({
      scientist: "Scientist",
      cid: "CID WALA",
      gd: "GD",
      eng: "Oongrej",
      good: "Achchhe Log"
    })[student.category] || student.category
  )}</span>
        <span class="expand-indicator" aria-hidden="true">+</span>
      </summary>
      <div class="student-expanded">
        <div class="student-expanded-photo-wrap">
          <img class="student-expanded-photo" src="${escapeHTML(student.photo)}" alt="" loading="lazy">
          <span class="expanded-id">CLASS ARCHIVE · ${String(student.id).padStart(2, "0")}</span>
        </div>
        <div class="student-expanded-content">
          <span class="eyebrow">A LITTLE MORE ABOUT THEM</span>
          <h4>${escapeHTML(student.name)}</h4>
          <p class="expanded-caption">${escapeHTML(student.caption)}</p>
          <blockquote>${escapeHTML(student.quote)}</blockquote>
          <div class="expanded-detail-grid">
            <div><span class="detail-label">KNOWN FOR</span><strong>${escapeHTML(student.traits)}</strong></div>
            <div><span class="detail-label">CLASS VIBE</span><strong>${escapeHTML(student.category === "scientist" ? "Scientist" : student.category === "gd" ? "GD" : student.category === "cid" ? "CID WALA" : student.category === "good" ? "Achchhe Log" : student.category === "eng" ? "Oongrej" : "Bina Mai Baap Ka")}</strong></div>
          </div>
          <p class="expanded-hint">${escapeHTML(student.bio)}</p>
        </div>
      </div>
    </details>`).join("") : `<div class="empty-state">No classmates found. Try another name or filter.</div>`;
  studentCount.textContent = `Showing ${filtered.length} of ${students.length} students`;
}



// Expandable student profiles. Keep one profile open at a time for a tidy directory.
studentList.addEventListener("toggle", event => {
  const opened = event.target;
  if (!(opened instanceof HTMLDetailsElement) || !opened.open) return;
  studentList.querySelectorAll("details.student-card[open]").forEach(card => {
    if (card !== opened) card.open = false;
  });
}, true);

studentSearch.addEventListener("input", renderStudents);
studentFilter.addEventListener("change", renderStudents);
renderStudents();

// Quote carousel: manual arrows plus automatic rotation.
let quoteIndex = 0;
const quoteText = document.querySelector("#quoteText");
const quoteAuthor = document.querySelector("#quoteAuthor");
const quoteIndexLabel = document.querySelector("#quoteIndex");
const quoteProgress = document.querySelector("#quoteProgress");
function showQuote(nextIndex) {
  quoteIndex = (nextIndex + quotes.length) % quotes.length;
  quoteText.textContent = quotes[quoteIndex].text;
  quoteAuthor.textContent = `— ${quotes[quoteIndex].author}`;
  quoteIndexLabel.textContent = `${String(quoteIndex + 1).padStart(2, "0")} / ${String(quotes.length).padStart(2, "0")}`;
  quoteProgress.style.width = `${((quoteIndex + 1) / quotes.length) * 100}%`;
}
document.querySelector("#prevQuote").addEventListener("click", () => showQuote(quoteIndex - 1));
document.querySelector("#nextQuote").addEventListener("click", () => showQuote(quoteIndex + 1));
showQuote(0);
let quoteTimer = window.setInterval(() => showQuote(quoteIndex + 1), 6500);
document.querySelector(".quote-band").addEventListener("mouseenter", () => window.clearInterval(quoteTimer));
document.querySelector(".quote-band").addEventListener("mouseleave", () => {
  window.clearInterval(quoteTimer);
  quoteTimer = window.setInterval(() => showQuote(quoteIndex + 1), 6500);
});

// Mobile navigation.
const menuToggle = document.querySelector("#menuToggle");
const nav = document.querySelector("#nav");
menuToggle.addEventListener("click", () => {
  const isOpen = nav.classList.toggle("open");
  menuToggle.setAttribute("aria-expanded", String(isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
});
nav.querySelectorAll("a").forEach(link => link.addEventListener("click", () => {
  nav.classList.remove("open");
  menuToggle.setAttribute("aria-expanded", "false");
}));

// Gallery detail dialog. Replace placeholder tiles with photos when ready.
const galleryDialog = document.querySelector("#galleryDialog");
document.querySelectorAll(".gallery-item").forEach((item, index) => {
  item.addEventListener("click", () => {
    document.querySelector("#dialogTitle").textContent = item.dataset.title;
    document.querySelector("#dialogCaption").textContent = item.dataset.caption;
    const art = document.querySelector("#dialogArt");
    const source = item.querySelector(".gallery-placeholder");
    art.className = `dialog-art ${source.classList.contains("gp-orange") ? "gp-orange" : source.classList.contains("gp-blue") ? "gp-blue" : "gp-purple"}`;
    art.textContent = ["✳", "✦", "★"][index % 3];
    galleryDialog.showModal();
  });
});
document.querySelector("#dialogClose").addEventListener("click", () => galleryDialog.close());
galleryDialog.addEventListener("click", event => {
  if (event.target === galleryDialog) galleryDialog.close();
});

/*
GAME INTEGRATION POINTS
-----------------------
Flappy Bird:
1. Put your game files in assets/flappy-bird/ (or a folder of your choice).
2. Replace the Flappy Bird visual placeholder in index.html with a <canvas> or an iframe.
3. If your game is in a separate HTML file, you can use:
   <iframe src="assets/flappy-bird/index.html" title="Flappy Bird game" loading="lazy"></iframe>
4. Give the iframe a responsive width and a sensible aspect ratio in styles.css.

Snake:
1. Add your Snake implementation to assets/snake/ or a separate JS module.
2. Replace the Snake visual placeholder and "In development" button with a Start Game button.
3. Consider keyboard controls plus touch controls for mobile.

Keep game code isolated from the directory/gallery scripts to avoid naming conflicts.
*/
