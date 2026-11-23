"use strict";

const GRADES = {
  basic: { label: "漢検3級", window: 5700, rise: 410, pace: 1 },
  intermediate: { label: "漢検準2級", window: 4800, rise: 300, pace: .90 },
  advanced: { label: "漢検2級", window: 3900, rise: 205, pace: .80 }
};
const OPPONENTS = {
  easy: { label: "初級CPU", min: 1800, max: 3300, accuracy: .60, pace: .86 },
  strong: { label: "中上級CPU", min: 1000, max: 2200, accuracy: .85, pace: .68 }
};
const BONUSES = { 3: 5, 5: 10, 10: 20 };
const SOUNDS = {
  start: [523, 659, 784],
  correct: [659, 880],
  wrong: [293, 220],
  combo: [660, 784, 988, 1174],
  tick: [520],
  end: [523, 392, 330],
  win: [523, 659, 784, 659, 784, 1047]
};
const $ = id => document.getElementById(id);
const board = $("board");
const scene = $("scene");
const layout = $("layout");
const setup = $("setup");
const holes = [];
const effectEnd = new Map();
const RECORD_KEY = "kanji-mogura.best.v1";
let view = "title";
let match = null;
let lastReview = [];
let frameId = 0;
let frozenAnimations = [];
let audioContext;
let audioGain;
let muted = false;
let records = { basic: 0, intermediate: 0, advanced: 0 };

try {
  const saved = JSON.parse(localStorage.getItem(RECORD_KEY));
  for (const grade of Object.keys(records)) {
    if (Number.isSafeInteger(saved?.[grade]) && saved[grade] >= 0) records[grade] = saved[grade];
  }
} catch {
  // 保存が無効なブラウザでも、このページを開いている間は記録を使える。
}

function shuffled(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function audioLevel() {
  if (audioGain) audioGain.gain.value = muted ? 0 : Number($("volume").value) / 100;
}

function unlockAudio() {
  try {
    if (!audioContext) {
      const AudioEngine = window.AudioContext || window.webkitAudioContext;
      if (!AudioEngine) return;
      audioContext = new AudioEngine();
      audioGain = audioContext.createGain();
      audioGain.connect(audioContext.destination);
      audioLevel();
    }
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  } catch {
    // 音声が使えない環境でも、文字とアニメーションで結果を伝える。
  }
}

function sound(name) {
  if (!audioGain || muted || $("volume").value === "0") return;
  const duration = name === "tick" ? .095 : name === "win" ? .18 : .12;
  SOUNDS[name].forEach((frequency, index) => {
    const note = audioContext.createOscillator();
    const envelope = audioContext.createGain();
    const start = audioContext.currentTime + index * duration * .85;
    note.type = name === "wrong" ? "triangle" : "sine";
    note.frequency.value = frequency;
    envelope.gain.setValueAtTime(.001, start);
    envelope.gain.exponentialRampToValueAtTime(.22, start + .015);
    envelope.gain.exponentialRampToValueAtTime(.001, start + duration);
    note.connect(envelope).connect(audioGain);
    note.start(start);
    note.stop(start + duration + .015);
    note.onended = () => { note.disconnect(); envelope.disconnect(); };
  });
}

function newStats() {
  return { score: 0, correct: 0, wrong: 0, streak: 0, maxStreak: 0 };
}

function applyAnswer(stats, correct) {
  const previous = stats.score;
  if (!correct) {
    stats.wrong++;
    stats.streak = 0;
    stats.score = Math.max(0, stats.score - 5);
    return { delta: stats.score - previous, bonus: 0 };
  }
  stats.correct++;
  stats.streak++;
  stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
  const bonus = BONUSES[stats.streak] ?? 0;
  stats.score += 10 + bonus;
  return { delta: 10, bonus };
}

function cpuPlan(profile) {
  return {
    delay: profile.min + Math.random() * (profile.max - profile.min),
    knows: Math.random() < profile.accuracy
  };
}

function setupValues() {
  const settings = new FormData(setup);
  return {
    mode: settings.get("mode"), grade: settings.get("grade"),
    duration: Number(settings.get("duration")), cpu: settings.get("cpu")
  };
}

function updateBest() {
  const { grade, mode } = setupValues();
  $("best-grade").textContent = GRADES[grade].label;
  $("best-score").textContent = records[grade] + " 点";
  $("cpu-settings").hidden = mode !== "versus";
}

function makeBoard() {
  for (let index = 0; index < 9; index++) {
    const hole = document.createElement("button");
    hole.type = "button";
    hole.className = "hole";
    hole.disabled = true;
    hole.innerHTML = '<span class="dirt"></span><span class="opening"></span><span class="burrow"><span class="mover"><span class="mole"><span class="muzzle"></span><span class="eye eye-left"></span><span class="eye eye-right"></span><span class="nose"></span><span class="mouth"></span><span class="cheek cheek-left"></span><span class="cheek cheek-right"></span></span><span class="sign"></span><span class="paw paw-left"></span><span class="paw paw-right"></span></span></span><span class="lip"></span>';
    hole.addEventListener("click", () => playAnswer(index));
    board.append(hole);
    holes.push({ hole, sign: hole.querySelector(".sign") });
  }
}

function setView(next) {
  view = next;
  layout.dataset.view = next;
  $("title").hidden = next !== "title";
  $("play-panel").hidden = next !== "title" && next !== "game";
  for (const id of ["preview-banner", "howto"]) $(id).hidden = next !== "title";
  for (const id of ["hud", "question", "feedback", "game-controls"]) $(id).hidden = next !== "game";
  $("result").hidden = next !== "result";
  $("review").hidden = next !== "review";
}

function clearHoles() {
  for (const [index, { hole, sign }] of holes.entries()) {
    hole.className = "hole";
    hole.disabled = true;
    hole.setAttribute("aria-label", (index + 1) + "番の穴");
    sign.textContent = "";
  }
}

function stopMatch() {
  cancelAnimationFrame(frameId);
  frameId = 0;
  frozenAnimations = [];
  layout.classList.remove("paused");
  $("pause-overlay").hidden = true;
  $("pause").disabled = false;
  match = null;
  effectEnd.clear();
  $("effects").replaceChildren();
  clearHoles();
}

function titleScreen(focus = false) {
  stopMatch();
  setView("title");
  updateBest();
  for (const [index, character] of [[0, "漢"], [4, "字"], [8, "王"]]) {
    holes[index].hole.classList.add("up");
    holes[index].sign.textContent = character;
  }
  if (focus) {
    window.scrollTo(0, 0);
    setup.querySelector(".start").focus({ preventScroll: true });
  }
}

function startMatch(settings, reviewQuestions = []) {
  stopMatch();
  unlockAudio();
  const practice = settings.mode === "practice";
  match = {
    settings, practice, source: practice ? reviewQuestions : KANJI_QUESTIONS[settings.grade],
    deck: [], previousId: "", player: newStats(), cpu: newStats(), missed: new Map(),
    start: performance.now(), elapsed: 0, duration: practice ? Infinity : settings.duration * 1000,
    pauseAt: null, round: null, number: 0, seconds: null
  };
  scene.style.setProperty("--rise", GRADES[settings.grade].rise + "ms");
  setView("game");
  window.scrollTo(0, 0);
  $("cpu-hud").hidden = settings.mode !== "versus";
  $("time-label").textContent = practice ? "復習の進み具合" : "残り時間";
  $("time-unit").textContent = practice ? "問" : "秒";
  $("question-track").hidden = practice;
  $("timer").classList.remove("urgent", "tick");
  sound("start");
  nextRound();
  updateHUD();
  frameId = requestAnimationFrame(tick);
}

function drawQuestion() {
  if (!match.deck.length) {
    match.deck = shuffled(match.source);
    if (match.deck.length > 1 && match.deck.at(-1).id === match.previousId) {
      match.deck.unshift(match.deck.pop());
    }
  }
  const question = match.deck.pop();
  match.previousId = question.id;
  return question;
}

function nextRound() {
  clearHoles();
  match.number++;
  const question = drawQuestion();
  const count = 2 + Math.floor(Math.random() * 3);
  const values = shuffled([question.answer, ...shuffled(question.distractors).slice(0, count - 1)]);
  const positions = shuffled(holes.map((_, index) => index)).slice(0, count);
  const options = new Map(positions.map((position, index) => [position, { word: values[index], state: "up", hideAt: Infinity }]));
  const grade = GRADES[match.settings.grade];
  const cpu = match.settings.mode === "versus" ? cpuPlan(OPPONENTS[match.settings.cpu]) : null;
  match.round = {
    question, options, availableAt: match.elapsed + grade.rise * .63,
    expiresAt: match.practice ? Infinity : match.elapsed + grade.window,
    advanceAt: Infinity, locked: false, cpuAt: cpu ? match.elapsed + cpu.delay : Infinity,
    cpuKnows: cpu?.knows
  };

  $("question-type").textContent = QUESTION_TYPES[question.type];
  $("question-number").textContent = match.practice ? match.number + " / " + match.source.length : "第 " + match.number + " 問";
  $("prompt").textContent = question.prompt;
  $("prompt").classList.toggle("meaning", question.type === "meaning");
  $("question-reading").hidden = question.type !== "meaning";
  $("question-reading").textContent = "読み「" + question.reading + "」";
  $("question-progress").style.transform = "scaleX(1)";
  $("feedback").textContent = match.practice ? "時間を気にせず、正しい札を選ぼう。" : "問題に合う札を選ぼう。";

  for (const [index, option] of options) {
    const { hole, sign } = holes[index];
    sign.textContent = option.word;
    hole.setAttribute("aria-label", option.word);
    hole.classList.add("up");
  }
}

function updateHUD() {
  $("player-score").textContent = match.player.score;
  $("cpu-score").textContent = match.cpu.score;
  if (match.practice) {
    $("time-value").textContent = match.player.correct + " / " + match.source.length;
    return;
  }
  const seconds = Math.max(0, Math.ceil((match.duration - match.elapsed) / 1000));
  if (seconds === match.seconds) return;
  match.seconds = seconds;
  $("time-value").textContent = seconds;
  $("timer").classList.toggle("urgent", seconds <= 10);
  if (seconds > 0 && seconds <= 10) {
    $("timer").classList.remove("tick");
    void $("timer").offsetWidth;
    $("timer").classList.add("tick");
    sound("tick");
  }
}

function addEffect(className, content, x, y, duration) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = content;
  if (x !== null) node.style.left = x + "px";
  if (y !== null) node.style.top = y + "px";
  $("effects").append(node);
  effectEnd.set(node, match.elapsed + duration);
  return node;
}

function celebrate(index, correct, result, streak) {
  const box = holes[index].hole.getBoundingClientRect();
  const field = scene.getBoundingClientRect();
  const x = box.left - field.left + box.width / 2;
  const y = box.top - field.top + box.height * .14;
  const label = correct ? "＋10" : result.delta < 0 ? "−" + Math.abs(result.delta) : "±0";
  addEffect(correct ? "score-pop" : "score-pop penalty", label, x, y, 760);
  if (!correct) return;
  for (let index = 0; index < (result.bonus ? 18 : 8); index++) {
    const petal = addEffect("particle", "", x, y + 12, 780);
    petal.style.setProperty("--x", (Math.random() - .5) * (result.bonus ? 220 : 120) + "px");
    petal.style.setProperty("--y", (-70 + Math.random() * 105) + "px");
  }
  if (result.bonus) addEffect("combo-pop", streak + "コンボ！ ＋" + result.bonus, null, null, 760);
}

function closeRound(outcome, chosen) {
  const round = match.round;
  round.locked = true;
  round.advanceAt = match.elapsed + (outcome === "timeout" ? 680 : 790);
  for (const [index, option] of round.options) {
    holes[index].hole.disabled = true;
    if (option.state === "up") option.hideAt = match.elapsed + (index === chosen ? 320 : 120);
  }
}

function answer(actor, index) {
  const round = match.round;
  const option = round.options.get(index);
  if (round.locked || match.elapsed < round.availableAt || match.elapsed >= round.expiresAt || option?.state !== "up") return;
  const correct = option.word === round.question.answer;
  const stats = match[actor];
  const result = applyAnswer(stats, correct);
  const { hole } = holes[index];
  hole.disabled = true;
  hole.classList.add(correct ? "correct" : "wrong");
  if (actor === "cpu") hole.classList.add("cpu");

  if (correct) closeRound("correct", index);
  else {
    option.hideAt = match.elapsed + 275;
    if (actor === "player") match.missed.set(round.question.id, round.question);
  }
  option.state = "selected";
  const who = actor === "cpu" ? "CPUが" : "";
  $("feedback").textContent = correct
    ? who + "正解！ " + round.question.word + "（" + round.question.reading + "）"
    : who + "不正解。ほかの札を選ぼう。";
  celebrate(index, correct, result, stats.streak);
  sound(result.bonus ? "combo" : correct ? "correct" : "wrong");
  updateHUD();
}

function timeoutRound() {
  const { question } = match.round;
  match.missed.set(question.id, question);
  match.player.streak = 0;
  match.cpu.streak = 0;
  closeRound("timeout");
  $("feedback").textContent = "時間切れ。正解は「" + question.word + "」";
}

function resolveCPU() {
  const round = match.round;
  round.cpuAt = Infinity;
  const available = [...round.options].filter(([, option]) => option.state === "up");
  const chosen = round.cpuKnows
    ? available.find(([, option]) => option.word === round.question.answer)
    : shuffled(available.filter(([, option]) => option.word !== round.question.answer))[0];
  if (chosen) answer("cpu", chosen[0]);
}

function step(now) {
  match.elapsed = now - match.start;
  if (match.elapsed >= match.duration) {
    // 最後の問題を終了前にクリックしていた場合も、集計はここで確定する。
    if (!match.round.locked) match.missed.set(match.round.question.id, match.round.question);
    finishMatch();
    return;
  }

  const round = match.round;
  if (match.elapsed >= round.advanceAt) {
    if (match.practice && match.number === match.source.length) {
      finishMatch();
      return;
    }
    nextRound();
    return;
  }

  updateHUD();
  if (!round.locked) {
    if (match.elapsed >= round.expiresAt) timeoutRound();
    else {
      if (match.elapsed >= round.availableAt) {
        for (const [index, option] of round.options) holes[index].hole.disabled = option.state !== "up";
      }
      if (match.elapsed >= round.cpuAt) resolveCPU();
    }
  }
  for (const [index, option] of round.options) {
    if (option.state === "down" || match.elapsed < option.hideAt) continue;
    option.state = "down";
    holes[index].hole.classList.remove("up");
    holes[index].hole.disabled = true;
  }
  for (const [node, end] of effectEnd) {
    if (match.elapsed < end) continue;
    node.remove();
    effectEnd.delete(node);
  }
  if (!match.practice) {
    const remaining = Math.max(0, round.expiresAt - match.elapsed);
    $("question-progress").style.transform = "scaleX(" + Math.min(1, remaining / GRADES[match.settings.grade].window) + ")";
  }
}

function tick(now) {
  frameId = 0;
  if (!match || match.pauseAt !== null) return;
  step(now);
  if (match) frameId = requestAnimationFrame(tick);
}

function playAnswer(index) {
  if (!match || match.pauseAt !== null || view !== "game") return;
  const round = match.round;
  step(performance.now());
  if (match?.round === round) answer("player", index);
}

function pause() {
  if (!match || match.pauseAt !== null) return;
  const now = performance.now();
  step(now);
  if (!match) return;
  match.pauseAt = now;
  cancelAnimationFrame(frameId);
  frameId = 0;
  frozenAnimations = scene.getAnimations?.({ subtree: true }).filter(animation => animation.playState === "running") ?? [];
  frozenAnimations.forEach(animation => animation.pause());
  layout.classList.add("paused");
  for (const { hole } of holes) hole.disabled = true;
  $("pause").disabled = true;
  $("pause-overlay").hidden = false;
  $("resume").focus();
}

function resume() {
  if (!match || match.pauseAt === null) return;
  match.start += performance.now() - match.pauseAt;
  match.pauseAt = null;
  layout.classList.remove("paused");
  frozenAnimations.forEach(animation => animation.play());
  frozenAnimations = [];
  $("pause-overlay").hidden = true;
  $("pause").disabled = false;
  $("pause").focus();
  frameId = requestAnimationFrame(tick);
}

function accuracy(stats) {
  const attempted = stats.correct + stats.wrong;
  return attempted ? Math.round(stats.correct / attempted * 100) : 0;
}

function titleRank(stats, settings) {
  const rate = accuracy(stats);
  if (settings.mode === "practice") {
    return rate >= 96 ? "漢字王" : rate >= 88 ? "漢字達人" : rate >= 77 ? "漢字名人" : rate >= 55 ? "漢字修行中" : "漢字見習い";
  }
  const grade = GRADES[settings.grade].pace;
  const cpu = settings.mode === "versus" ? OPPONENTS[settings.cpu].pace : 1;
  const normalizedScore = stats.score / (settings.duration * grade * cpu);
  if (normalizedScore >= 4.6 && rate >= 92) return "漢字王";
  if (normalizedScore >= 3.3 && rate >= 84) return "漢字達人";
  if (normalizedScore >= 2.1 && rate >= 72) return "漢字名人";
  if (normalizedScore >= 1 && rate >= 50) return "漢字修行中";
  return "漢字見習い";
}

function stat(label, value) {
  const node = document.createElement("div");
  node.className = "stat";
  const number = document.createElement("strong");
  number.textContent = value;
  node.append(label, number);
  return node;
}

function finishMatch() {
  const completed = match;
  stopMatch();
  const { settings, practice, player, cpu, missed } = completed;
  let record = false;
  if (settings.mode === "solo" && player.score > records[settings.grade]) {
    records[settings.grade] = player.score;
    record = true;
    try {
      localStorage.setItem(RECORD_KEY, JSON.stringify(records));
    } catch {
      record = false;
    }
  }
  lastReview = [...missed.values()];
  const outcome = settings.mode !== "versus" ? "solo"
    : player.score > cpu.score ? "win" : player.score < cpu.score ? "loss" : "draw";
  const result = {
    settings, player, cpu, record, outcome, practice,
    retrySource: practice ? [...completed.source] : [], review: lastReview
  };
  sound(outcome === "win" ? "win" : "end");
  showResult(result);
}

function showResult(result) {
  const { settings, player, cpu, record, outcome, practice, retrySource, review } = result;
  lastReview = review;
  setView("result");
  $("result").dataset.outcome = outcome;
  const [heading, ornament] = {
    solo: [practice ? "復習おつかれさま！" : "ゲーム終了！", "✿"],
    win: ["あなたの勝ち！", "勝"],
    loss: ["CPUの勝ち", "挑"],
    draw: ["引き分け！", "結"]
  }[outcome];
  $("result-heading").textContent = heading;
  $("result-ornament").textContent = ornament;
  const mode = practice ? "復習" : settings.mode === "versus" ? OPPONENTS[settings.cpu].label + "対戦" : "1人プレイ";
  $("result-meta").textContent = GRADES[settings.grade].label + " ／ " + mode + (practice ? "" : " ／ " + settings.duration + "秒");
  $("result-note").textContent = record ? "最高得点を更新しました！" : outcome === "loss" ? "もう一度、腕試ししてみよう。" : "";
  $("result-note").hidden = !$("result-note").textContent;
  const stats = [
    stat("最終得点", player.score + "点"), stat("正解数", player.correct + "問"),
    stat("不正解数", player.wrong + "回"), stat("正解率", accuracy(player) + "％"),
    stat("最大コンボ", player.maxStreak + "回"), stat("称号", titleRank(player, settings))
  ];
  if (settings.mode === "versus") stats.push(stat("CPUの最終得点", cpu.score + "点"));
  $("result-stats").replaceChildren(...stats);
  $("again").onclick = () => startMatch(settings, retrySource);
  $("show-review").onclick = () => showReview(result);
  window.scrollTo(0, 0);
  $("result-heading").focus({ preventScroll: true });
}

function showReview(result) {
  setView("review");
  $("review-heading").textContent = lastReview.length ? "間違えた漢字を復習" : "全問正解！おめでとう！";
  $("review-intro").textContent = lastReview.length ? lastReview.length + "問・時間制限なしで再挑戦できます。" : "";
  $("review-start").hidden = !lastReview.length;
  $("review-start").onclick = () => startMatch({ ...result.settings, mode: "practice" }, lastReview);
  $("review-back").onclick = () => showResult(result);
  const elements = lastReview.map(question => {
    const entry = document.createElement("article");
    entry.className = "review-item";
    const type = document.createElement("small");
    type.textContent = QUESTION_TYPES[question.type];
    const prompt = document.createElement("h3");
    prompt.textContent = question.prompt + (question.type === "meaning" ? "（" + question.reading + "）" : "");
    const solution = document.createElement("p");
    solution.textContent = "正解 " + question.answer + (question.type === "idiom" ? "（" + question.word + "）" : "") + " ／ 読み " + question.reading;
    const meaning = document.createElement("p");
    meaning.textContent = question.meaning;
    entry.append(type, prompt, solution, meaning);
    return entry;
  });
  $("review-entries").replaceChildren(...elements);
  window.scrollTo(0, 0);
  $("review-heading").focus({ preventScroll: true });
}

setup.addEventListener("change", updateBest);
setup.addEventListener("submit", event => {
  event.preventDefault();
  startMatch(setupValues());
});
$("mute").addEventListener("click", () => {
  muted = !muted;
  $("mute").setAttribute("aria-pressed", String(muted));
  $("mute").title = muted ? "ミュートを解除" : "ミュート";
  audioLevel();
});
$("volume").addEventListener("input", audioLevel);
$("pause").addEventListener("click", pause);
$("resume").addEventListener("click", resume);
$("exit").addEventListener("click", () => titleScreen(true));
$("result-home").addEventListener("click", () => titleScreen(true));
$("review-home").addEventListener("click", () => titleScreen(true));
document.addEventListener("visibilitychange", () => { if (document.hidden && view === "game") pause(); });
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || view !== "game") return;
  if (match.pauseAt === null) pause();
  else resume();
});

makeBoard();
titleScreen();

