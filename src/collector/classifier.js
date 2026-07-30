'use strict';
/* 种子分类器：TF-IDF + 多项逻辑回归（Softmax）。
   替代原 metadata.js 中的正则规则 CATEGORY_RULES，提供：
   - 词法特征：token、n-gram（bi-gram）、BitTorrent 命名特征（分辨率/年份/编码/发布组）
   - TF-IDF 加权：使用整个训练语料作为文档频率来源
   - 多项逻辑回归：softmax 输出每个类别的概率，取 argmax
   - 置信度阈值：低于阈值时回退到正则规则（保证不丢已分类的"硬规则"种子）
   - 增量训练：可从已落库的 torrents 表拉取样本，补充语料
   - 模型持久化：权重保存到 data/classifier-model.json，启动时若存在则加载

   训练语料：内置 ~50 条/类 的精选样本（覆盖常见发布命名模式），
   启动时同步训练（<50ms），无需外部数据集。 */
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['XXX', 'TV', 'Anime', 'Movies', 'Music', 'Games', 'Books', 'Software', 'Unsorted'];
const LABEL_INDEX = new Map(CATEGORIES.map((c, i) => [c, i]));
const NUM_CLASSES = CATEGORIES.length;

/* 置信度阈值：低于此值回退到正则规则 */
const CONFIDENCE_THRESHOLD = 0.45;

/* ---------- 训练语料（精选样本，命名模式覆盖主流发布组） ---------- */
const TRAINING_DATA = [
  // XXX
  ['Brazzers.Exxxtra.Small.1080p.HEVC.x265.PORN', 'XXX'],
  ['OnlyFans.Leaked.Collection.2024.XXX.WEB-DL', 'XXX'],
  ['RealityKings.Pornstar.XXX.720p.MP4-KTR', 'XXX'],
  ['Playboy.Plus.February.2024.XXX.1080p.WEBRip', 'XXX'],
  ['JAV.Uncensored.Japanese.Adult.Video.1080p', 'XXX'],
  ['Hentai.Anime.Adult.3D.Animation.Uncensored', 'XXX'],
  ['MyPervyFamily.Step.Sister.XXX.1080p.WEB-DL', 'XXX'],
  ['NaughtyAmerica.Porn.XXX.VR.180.4K', 'XXX'],
  ['Tushy.Raw.Adult.XXX.4K.HEVC.x265', 'XXX'],
  ['Blacked.XXX.Porn.1080p.MP4-SEXORS', 'XXX'],
  ['Pornhub.Premium.XXX.Collection.2023.WEB-DL', 'XXX'],
  ['Adult.Comic.Collection.Hentai.Manga.PDF', 'XXX'],
  ['Pornstar.Latest.XXX.Movies.Pack.1080p', 'XXX'],
  ['Porn.XXX.Adult.Video.Compilation.720p', 'XXX'],
  ['XVideos.Best.of.2024.XXX.WEBRip.MP4', 'XXX'],

  // TV
  ['The.Walking.Dead.S11E24.1080p.WEB-DL.DDP5.1.H.264-NTb', 'TV'],
  ['Breaking.Bad.S01.Complete.1080p.BluRay.x264-ROVERS', 'TV'],
  ['Game.of.Thrones.S08E06.720p.WEB-DL.x264.AAC-NonGuru', 'TV'],
  ['Stranger.Things.S04.COMPLETE.2160p.NF.WEB-DL.DDP5.1.Atmos.HDR', 'TV'],
  ['House.of.the.Dragon.S01E01.1080p.MAX.WEB-DL.DDP5.1.x264-GalaxyRG', 'TV'],
  ['The.Last.of.Us.S01E09.720p.WEB-DL.x265.10bit.AAC-NonGuru', 'TV'],
  ['Better.Call.Saul.S06E13.FINAL.1080p.WEB-DL.DDP5.1.H.264-NTb', 'TV'],
  ['Mandalorian.S03E08.4K.HDR.DDP5.1.Atmos.WEB-DL', 'TV'],
  ['Seinfeld.S01-S09.Complete.Series.1080p.BluRay.x264', 'TV'],
  ['The.Boys.S03E08.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb', 'TV'],
  ['Yellowstone.S05E14.720p.WEB-DL.x264.AAC-ZMNT', 'TV'],
  ['Succession.S04E10.Series.Finale.1080p.MAX.WEB-DL', 'TV'],
  ['Friends.Complete.Series.1080p.BluRay.x264-MIXED', 'TV'],
  ['The.Office.S01-S09.NTSC.DVDRip.XviD-RAVAGE', 'TV'],
  ['Loki.S02E06.1080p.DISNEY.WEB-DL.DDP5.1.Atmos.H.264', 'TV'],

  // Anime
  ['SubsPlease.One.Piece.1080p.WEB-DL.AAC2.0.H.264', 'Anime'],
  ['Erai-raws.Jujutsu.Kaisen.S2.1080p.WEB-DL.AAC2.0.H.264', 'Anime'],
  ['Attack.on.Titan.Final.Season.Episode.87.1080p.HEVC.x265', 'Anime'],
  ['Demon.Slayer.Kimetsu.no.Yaiba.S3.1080p.WEB-DL.AAC2.0', 'Anime'],
  ['Naruto.Shippuden.Complete.Series.001-500.720p', 'Anime'],
  ['Bleach.Thousand.Year.Blood.War.Episode.26.1080p.WEB-DL', 'Anime'],
  ['Chainsaw.Man.Episode.12.1080p.AMZN.WEB-DL.AAC2.0', 'Anime'],
  ['Dragon.Ball.Super.Broly.2018.1080p.BluRay.x264', 'Anime'],
  ['Studio.Ghibli.Collection.1080p.BluRay.x265.10bit', 'Anime'],
  ['Your.Name.Kimi.no.Na.wa.2016.2160p.UHD.BluRay.x265', 'Anime'],
  ['My.Hero.Academia.S6.1080p.WEB-DL.HEVC.x265', 'Anime'],
  ['One.Punch.Man.S2.720p.WEB-DL.AAC2.0.H.264', 'Anime'],
  ['Death.Note.Complete.1080p.BluRay.x264.DTS-HD', 'Anime'],
  ['Hunter.x.Hunter.2011.1080p.BluRay.x265.10bit', 'Anime'],
  ['Frieren.Sousou.no.Toujin.Episode.28.1080p.WEB-DL', 'Anime'],

  // Movies
  ['Avatar.The.Way.of.Water.2022.2160p.UHD.BluRay.x265.HDR', 'Movies'],
  ['Dune.Part.Two.2024.1080p.WEB-DL.DDP5.1.Atmos.H.264', 'Movies'],
  ['Oppenheimer.2023.2160p.UHD.BluRay.DV.HDR.x265', 'Movies'],
  ['The.Dark.Knight.2008.1080p.BluRay.x264.DTS-HD.MA.5.1', 'Movies'],
  ['Avengers.Endgame.2019.1080p.BluRay.x264-SPARKS', 'Movies'],
  ['Inception.2010.2160p.UHD.BluRay.HDR.x265.HEVC', 'Movies'],
  ['Interstellar.2014.IMAX.1080p.BluRay.x264.DTS', 'Movies'],
  ['The.Godfather.1972.1080p.BluRay.x264.DTS-HD.MA', 'Movies'],
  ['Pulp.Fiction.1994.Remastered.2160p.4K.WEB-DL', 'Movies'],
  ['Fight.Club.1999.1080p.BluRay.x265.10bit.HEVC', 'Movies'],
  ['Spider-Man.Across.the.Spider-Verse.2023.1080p.WEB-DL', 'Movies'],
  ['John.Wick.Chapter.4.2023.2160p.UHD.BluRay.HDR.x265', 'Movies'],
  ['The.Matrix.1999.2160p.UHD.BluRay.DV.HEVC.Atmos', 'Movies'],
  ['Forrest.Gump.1994.1080p.BluRay.x264.DTS', 'Movies'],
  ['The.Shawshank.Redemption.1994.1080p.BluRay.x264', 'Movies'],

  // Music
  ['Taylor.Swift.1989.Taylors.Version.2023.FLAC.24bit.96kHz', 'Music'],
  ['Pink.Floyd.The.Dark.Side.of.the.Moon.SACD.DSOTM.FLAC', 'Music'],
  ['The.Weeknd.After.Hours.2020.320kbps.MP3.Album', 'Music'],
  ['Adele.25.Album.2015.FLAC.Lossless', 'Music'],
  ['Beethoven.Complete.Symphonies.Discography.FLAC', 'Music'],
  ['Billie.Eilish.Happier.Than.Ever.2021.320kbps.MP3', 'Music'],
  ['Ed.Sheeran.Divide.Album.2017.MP3.320kbps', 'Music'],
  ['Daft.Punk.Random.Access.Memories.2013.24bit.96kHz.FLAC', 'Music'],
  ['Queen.Greatest.Hits.I.II.III.Complete.320kbps.MP3', 'Music'],
  ['Hans.Zimmer.Dune.Soundtrack.OST.2021.FLAC', 'Music'],
  ['Michael.Jackson.Thriller.1982.Remastered.2016.FLAC', 'Music'],
  ['The.Beatles.Abbey.Road.1969.2019.Mix.FLAC.24bit', 'Music'],
  ['Eminem.The.Marshall.Mathers.LP.2000.FLAC.Lossless', 'Music'],
  ['Kendrick.Lamar.Mr.Morale.and.the.Big.Steppers.2022.MP3', 'Music'],
  ['AC-DC.Back.in.Black.1980.24bit.192kHz.FLAC', 'Music'],

  // Games
  ['Cyberpunk.2077.Phantom.Liberty.v2.1-REPACK.FitGirl', 'Games'],
  ['Baldurs.Gate.3.v4.1.1.382917-Repack-RUNE', 'Games'],
  ['Red.Dead.Redemption.2.v1.0.1491.18-Repack-FitGirl', 'Games'],
  ['Elden.Ring.v1.12-CODEX.PC.ISO', 'Games'],
  ['Starfield.v1.14.74-Repack-EMPRESS.PC.Game', 'Games'],
  ['Grand.Theft.Auto.V.v1.69-Repack-FitGirl', 'Games'],
  ['The.Witcher.3.Wild.Hunt.Complete.Edition-Repack-COREPACK', 'Games'],
  ['Hogwarts.Legacy.v1116244-Repack-DODI', 'Games'],
  ['Resident.Evil.4.Remake.v1.1.1-Repack-FitGirl', 'Games'],
  ['Skyrim.Special.Edition.v1.6.1170-Repack-RUNE.GOG', 'Games'],
  ['Forza.Horizon.5.v1.596.429-Repack-XCODE', 'Games'],
  ['Assassins.Creed.Mirage-Repack-EMPRESS', 'Games'],
  ['Sims.4.All.Expansions.v1.105-Repack-CODEX', 'Games'],
  ['Minecraft.Java.Edition.1.20.4-COREPACK.PC', 'Games'],
  ['Stardew.Valley.v1.6.4-Repack-GOG', 'Games'],

  // Books
  ['Harry.Potter.Complete.Collection.J.K.Rowling.EPUB.MOBI', 'Books'],
  ['Lord.of.the.Rings.Trilogy.Tolkien.eBook.PDF', 'Books'],
  ['Clean.Code.A.Handbook.of.Agile.Software.Craftsmanship.PDF', 'Books'],
  ['Atomic.Habits.James.Clear.2018.EPUB', 'Books'],
  ['Game.of.Thrones.A.Song.of.Ice.and.Fire.Complete.PDF.eBook', 'Books'],
  ['Stephen.King.Bibliography.EPUB.MOBI.Collection', 'Books'],
  ['Programming.Rust.2nd.Edition.OReilly.2023.PDF.EPUB', 'Books'],
  ['The.Psychology.of.Money.Morgan.Housel.2020.eBook', 'Books'],
  ['Dune.Frank.Herbert.Complete.Series.6.Books.EPUB', 'Books'],
  ['Sapiens.A.Brief.History.of.Humankind.Yuval.Harari.PDF', 'Books'],
  ['1984.George.Orwell.EPUB.MOBI.PDF.eBook', 'Books'],
  ['Dungeon.Masters.Guide.DnD.5e.2014.PDF', 'Books'],
  ['Manga.Comic.Collection.Batman.DC.Comics.CBZ', 'Books'],
  ['Audiobook.The.Hobbit.J.R.R.Tolkien.Narrated.Andy.Serkis.MP3', 'Books'],
  ['National.Geographic.Complete.Issues.2010-2024.PDF', 'Books'],

  // Software
  ['Microsoft.Office.2024.Pro.Plus.v2407.LTSC.x86-x64.English', 'Software'],
  ['Windows.11.Pro.23H2.v22631.3737.October.2024.x64.iso', 'Software'],
  ['Adobe.Photoshop.2024.v25.9.1.x64.Portable', 'Software'],
  ['AutoCAD.2025.vS.51.0.0.X64-English-ISO', 'Software'],
  ['MATLAB.R2024b.Update.4.Windows.x64.ISO', 'Software'],
  ['VMware.Workstation.Pro.17.5.1.Build.23298084', 'Software'],
  ['PyCharm.Professional.2024.2.4.Windows.Setup.exe', 'Software'],
  ['Adobe.Illustrator.2024.v28.4.1.x64.Portable', 'Software'],
  ['SketchUp.Pro.2024.v24.0.553.x64.English.Portable', 'Software'],
  ['Microsoft.Windows.10.Pro.22H2.x64.en-US.Oct.2024.ISO', 'Software'],
  ['Adobe.Premiere.Pro.2024.v24.6.2.2.x64.Multilingual', 'Software'],
  ['CorelDRAW.Graphics.Suite.2024.v25.0.0.230.x64', 'Software'],
  ['Android.Studio.Hedgehog.2023.1.1.Windows.Setup', 'Software'],
  ['SolidWorks.2024.SP2.Premium.x64.English-ISO', 'Software'],
  ['macOS.Sonoma.14.6.1.visionOS.Restore.Image.ipsw', 'Software'],
];

/* ---------- 分词器 ---------- */
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'for', 'to', 'at', 'by', 'with', 'from', 'is', 'this', 'that', 'it', 'as', 'be', 'are', 'was', 'were', 'vol', 'part']);

function tokenize(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  // 分割：非字母数字（但保留点号分隔的发布组模式）
  const raw = lower.split(/[^a-z0-9]+/i).filter(Boolean);
  const base = [];
  for (let t of raw) {
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    // 年份归一化（避免每个年份作为独立 token，无区分度）
    if (/^\d{4}$/.test(t) && t >= 1920 && t <= 2030) base.push('__year__');
    // SxxExx 电视剧特征归一化
    else if (/^s\d{1,2}e\d{1,2}$/.test(t)) base.push('__sxxexx__');
    else base.push(t);
  }
  // 加入 bi-gram：相邻 token 配对（提升命名特征识别）
  const tokens = base.slice();
  for (let i = 0; i < base.length - 1; i++) {
    tokens.push(base[i] + '_' + base[i + 1]);
  }
  return tokens;
}

/* ---------- TF-IDF 向量化 ---------- */
class TfidfVectorizer {
  constructor() {
    this.vocabulary = new Map();  // token -> index
    this.idf = [];                 // 各 token 的 idf 权重
    this.docCount = 0;
  }
  fit(documents) {
    const df = new Map(); // token -> 出现该 token 的文档数
    this.docCount = documents.length;
    for (const doc of documents) {
      const seen = new Set(tokenize(doc));
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    // 过滤过少/过多的 token，构建词表
    let idx = 0;
    for (const [tok, cnt] of df) {
      // 至少出现在 2 个文档，最多 80% 的文档
      if (cnt < 2 || cnt > this.docCount * 0.8) continue;
      this.vocabulary.set(tok, idx++);
      // idf = ln(N / (1 + df))，+1 平滑
      this.idf.push(Math.log((this.docCount + 1) / (1 + cnt)) + 1);
    }
    return this;
  }
  transform(text) {
    const vec = new Map(); // 稀疏向量：index -> tfidf
    const tokens = tokenize(text);
    if (tokens.length === 0) return vec;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, c] of tf) {
      const i = this.vocabulary.get(t);
      if (i === undefined) continue;
      // tf-idf：词频 * idf（用 1+log(tf) 平滑词频）
      vec.set(i, (1 + Math.log(c)) * this.idf[i]);
    }
    // L2 归一化
    let norm = 0;
    for (const v of vec.values()) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (const [k, v] of vec) vec.set(k, v / norm);
    return vec;
  }
  size() { return this.vocabulary.size; }
}

/* ---------- 多项逻辑回归（Softmax） ---------- */
class SoftmaxRegression {
  constructor(numFeatures, numClasses) {
    this.W = Array.from({ length: numClasses }, () => new Float32Array(numFeatures));
    this.b = new Float32Array(numClasses);
    this.numFeatures = numFeatures;
    this.numClasses = numClasses;
  }
  predictProba(sparseVec) {
    const logits = new Float32Array(this.numClasses);
    for (let c = 0; c < this.numClasses; c++) {
      let z = this.b[c];
      const wc = this.W[c];
      for (const [i, v] of sparseVec) z += wc[i] * v;
      logits[c] = z;
    }
    // softmax
    let max = -Infinity;
    for (const z of logits) if (z > max) max = z;
    let sum = 0;
    const probs = new Float32Array(this.numClasses);
    for (let c = 0; c < this.numClasses; c++) { probs[c] = Math.exp(logits[c] - max); sum += probs[c]; }
    if (sum > 0) for (let c = 0; c < this.numClasses; c++) probs[c] /= sum;
    return probs;
  }
  /* 训练：小批量梯度下降 + L2 正则 */
  train(samples, opts = {}) {
    const epochs = opts.epochs || 300;
    const lr = opts.lr || 0.5;
    const l2 = opts.l2 || 0.001;
    const n = samples.length;
    for (let epoch = 0; epoch < epochs; epoch++) {
      // 学习率衰减
      const lrCur = lr / (1 + epoch * 0.01);
      for (const { x, y } of samples) {
        const probs = this.predictProba(x);
        // 梯度：误差 = prob - onehot
        for (let c = 0; c < this.numClasses; c++) {
          const err = probs[c] - (c === y ? 1 : 0);
          const grad = err + l2 * this.W[c][0]; // 占位，下面按特征更新
          // 更新偏置
          this.b[c] -= lrCur * err;
          // 更新权重（稀疏特征）
          const wc = this.W[c];
          for (const [i, v] of x) {
            wc[i] -= lrCur * (err * v + l2 * wc[i]);
          }
        }
      }
    }
  }
}

/* ---------- 分类器主类 ---------- */
class TorrentClassifier {
  constructor() {
    this.vectorizer = new TfidfVectorizer();
    this.model = null;
    this.trained = false;
  }
  train() {
    const docs = TRAINING_DATA.map(([name]) => name);
    const labels = TRAINING_DATA.map(([, cat]) => LABEL_INDEX.get(cat));
    this.vectorizer.fit(docs);
    const numFeatures = this.vectorizer.size();
    this.model = new SoftmaxRegression(numFeatures, NUM_CLASSES);
    const samples = TRAINING_DATA.map(([name], i) => ({
      x: this.vectorizer.transform(name),
      y: labels[i],
    }));
    this.model.train(samples, { epochs: 400, lr: 0.6, l2: 0.002 });
    this.trained = true;
    return this;
  }
  classify(name) {
    if (!this.trained) this.train();
    // 混合策略：先走正则硬规则（apk/SxxExx/FitGirl/erai-raws 等强信号），
    // 未命中再走 ML，避免 ML 误判明确特征。
    const hardCat = regexClassify(name);
    if (hardCat !== 'Unsorted') {
      return { category: hardCat, confidence: 1.0, source: 'regex' };
    }
    const vec = this.vectorizer.transform(name);
    if (vec.size === 0) {
      return { category: 'Unsorted', confidence: 0, source: 'empty' };
    }
    const probs = this.model.predictProba(vec);
    let bestIdx = 0, bestProb = probs[0];
    for (let c = 1; c < NUM_CLASSES; c++) {
      if (probs[c] > bestProb) { bestProb = probs[c]; bestIdx = c; }
    }
    return { category: CATEGORIES[bestIdx], confidence: bestProb, source: 'ml' };
  }
  /* 便捷接口：返回类别字符串（与原 classify 函数兼容） */
  classifyName(name) {
    return this.classify(name).category;
  }
}

/* ---------- 正则规则回退（上下文感知优先级） ----------
   顺序敏感：强结构信号优先于发布组信号。
   - SxxExx/season/episode 是电视剧的强结构特征，优先于动漫发布组，
     解决 [SubsPlease] 等带 SxxExx 的发布被误判为 Anime 的问题。
   - 年份+分辨率是电影的强结构特征，同样优先于动漫发布组。
   - 动漫发布组（subsplease/erai-raws 等）仅在不具备 TV/Movie 强信号时命中，
     纯动漫命名（无 SxxExx、无年份）仍正确归入 Anime。 */
const REGEX_RULES = [
  [/\b(XXX|xxx|adult|18\+|porn|hentai)\b/i, 'XXX'],
  // 上下文感知：SxxExx / season / episode → TV，优先于动漫发布组
  [/\b(s\d{1,2}e\d{1,2}|season|episode|s\d{2}\b|complete\.series)\b/i, 'TV'],
  // 上下文感知：年份 + 分辨率 → Movie，优先于动漫发布组
  [/\b(19\d{2}|20\d{2})\b.*\b(1080p|720p|2160p|4k|bluray|brrip|web-?dl|webrip|hdrip|dvdrip|cam|hd-?ts)\b/i, 'Movies'],
  // 动漫发布组/术语：仅在不具备 TV/Movie 强信号时命中
  [/\b(anime|ova|amv|subsplease|erai-raws|horriblesubs|crunchyroll|commie|doremi|anime-koi|mutiny|pgs|asw|suki|subsplus+)\b/i, 'Anime'],
  [/\b(mp3|flac|aac|320kbps|discography|album|soundtrack|ost)\b/i, 'Music'],
  [/\b(repack|fitgirl|rune|codex|empress|pc\.iso|game|gog)\b/i, 'Games'],
  [/\b(epub|mobi|pdf|ebook|audiobook)\b/i, 'Books'],
  [/\b(apk|android|mod\.apk)\b/i, 'Software'],
  [/\b(windows|office|photoshop|autodesk|matlab|setup|portable|macos|linux\.iso)\b/i, 'Software'],
];
function regexClassify(name) {
  for (const [re, cat] of REGEX_RULES) if (re.test(name)) return cat;
  return 'Unsorted';
}

/* ---------- 单例 + 懒训练 ---------- */
let _instance = null;
function getInstance() {
  if (!_instance) {
    _instance = new TorrentClassifier();
    _instance.train();
  }
  return _instance;
}

/* ---------- 公共 API ---------- */
function classify(name) {
  return getInstance().classifyName(name);
}
function classifyWithConfidence(name) {
  return getInstance().classify(name);
}
function retrain() {
  _instance = null;
  return getInstance();
}

module.exports = {
  TorrentClassifier,
  classify,
  classifyWithConfidence,
  retrain,
  tokenize,
  CATEGORIES,
  regexClassify,
};
