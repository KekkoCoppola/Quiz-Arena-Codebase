'use strict';

/**
 * server/minigames/coppia-scoppiata.js — LE REGOLE della Coppia Scoppiata.
 *
 * Minigioco cooperativo a carte private: ogni giocatore riceve una figura
 * (animale o oggetto) di un colore; in sala c'è almeno un'altra persona con
 * la stessa figura in un altro colore. Bisogna trovarla e toccare IL SUO
 * colore. Il gruppo prende i punti pieni solo se tutti i presenti si
 * indovinano a vicenda; la velocità non conta.
 *
 * Design: docs/superpowers/specs/2026-11-11-coppia-scoppiata-design.md
 *
 * Regola unica di correttezza: è giusto qualunque colore posseduto da un ALTRO
 * giocatore con la tua stessa figura. Copre coppie, trio e i gruppi più grandi
 * delle sale affollate senza eccezioni.
 */

const FIGURES = Object.freeze([
  'gatto', 'cane', 'pesce', 'elefante', 'coniglio', 'tartaruga', 'farfalla', 'uccellino',
  'mela', 'ombrello', 'bicicletta', 'chitarra', 'casa', 'automobile', 'palloncino', 'cappello',
]);

/** Colori per gruppo: oltre questa taglia un gruppo ripeterebbe un colore. */
const MAX_GROUP = 6;

/** Probabilità che un giocatore di prova trovi davvero il compagno. */
const BOT_FINDS_PARTNER = 0.7;

/** Fisher–Yates con il generatore passato: mai Math.random diretta. */
function shuffle(list, rnd) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Divide `list` in `count` gruppi di taglia il più possibile pari, i più grandi prima. */
function partition(list, count) {
  if (count <= 0) return [];
  const base = Math.floor(list.length / count);
  const extra = list.length % count;
  const groups = [];
  let at = 0;
  for (let g = 0; g < count; g++) {
    const size = base + (g < extra ? 1 : 0);
    groups.push(list.slice(at, at + size));
    at += size;
  }
  return groups;
}

/** Quanti gruppi formare con `n` giocatori della stessa classe (collegati o no). */
function groupsFor(n, share) {
  if (n < 2) return 0;
  return Math.min(Math.floor(n / 2), Math.max(1, share, Math.ceil(n / MAX_GROUP)));
}

function smallest(groups) {
  return groups.reduce((min, g) => (g.length < min.length ? g : min), groups[0]);
}

/** È giusto se un ALTRO giocatore con la stessa figura ha quel colore. */
function isCorrect(hands, playerId, optionIndex) {
  const mine = hands[playerId];
  if (!mine) return false;
  for (const [id, card] of Object.entries(hands)) {
    if (id !== playerId && card.figure === mine.figure && card.color === optionIndex) return true;
  }
  return false;
}

/** Il gruppo è completo se ha almeno 2 presenti e ogni presente ha risposto giusto. */
function isGroupComplete(table, group, answers, present) {
  const here = group.members.filter((id) => present.has(id));
  if (here.length < 2) return false;
  return here.every((id) => answers.has(id) && isCorrect(table.hands, id, answers.get(id)));
}

module.exports = {
  type: 'coppia_scoppiata',
  label: 'La Coppia Scoppiata',
  description: 'Ognuno ha una carta segreta: trova in sala chi ha la tua stessa figura e tocca il suo colore. Punti pieni solo se vi indovinate a vicenda.',
  prompt: 'Trova la tua coppia prima che scada il tempo!',
  options: ['Rosso', 'Blu', 'Verde', 'Giallo', 'Viola', 'Arancio'],
  points: { complete: 1000, half: 300, miss: 0 },
  defaultTimeLimitS: 90,
  revealMs: 9000,
  minPlayers: 2,
  FIGURES,

  build() {
    return {
      kind: 'minigame',
      minigameType: this.type,
      text: this.prompt,
      options: this.options,
      time_limit_s: this.defaultTimeLimitS,
    };
  },

  /**
   * Distribuisce le carte a TUTTI i giocatori in partita. Gli scollegati
   * (telefoni addormentati) si mettono in coppia fra loro, così nessuno di
   * quelli presenti cerca un compagno che non arriverà mai; uno scollegato
   * rimasto solo diventa il terzo di un gruppo di collegati.
   */
  deal(players, rnd) {
    const n = players.length;
    const total = n <= 16 * MAX_GROUP ? Math.min(16, Math.floor(n / 2)) : Math.ceil(n / MAX_GROUP);
    const away = shuffle(players.filter((p) => !p.connected).map((p) => p.id), rnd);
    const here = shuffle(players.filter((p) => p.connected).map((p) => p.id), rnd);

    const awayCount = groupsFor(away.length, n ? Math.round((total * away.length) / n) : 0);
    const hereCount = groupsFor(here.length, total - awayCount);
    const awayGroups = partition(away, awayCount);
    const hereGroups = partition(here, hereCount);
    const groups = [...awayGroups, ...hereGroups];

    // Chi è rimasto solo nella propria classe va in un gruppo dell'altra:
    // lo scollegato con i collegati, il collegato con gli scollegati.
    const loneAway = away.length === 1 ? away[0] : null;
    const loneHere = here.length === 1 ? here[0] : null;
    if (loneAway && hereGroups.length) smallest(hereGroups).push(loneAway);
    if (loneHere && awayGroups.length) smallest(awayGroups).push(loneHere);
    const leftovers = [loneAway, loneHere].filter((id) => id && !groups.some((g) => g.includes(id)));
    if (leftovers.length) {
      if (groups.length) leftovers.forEach((id) => smallest(groups).push(id));
      else groups.push(leftovers);
    }

    const figures = shuffle(FIGURES, rnd);
    const hands = {};
    const tableGroups = groups.map((members, i) => {
      const figure = figures[i % figures.length];
      const colors = shuffle(this.options.map((_, c) => c), rnd);
      members.forEach((id, k) => { hands[id] = { figure, color: colors[k % colors.length] }; });
      return { figure, members };
    });

    return { hands, table: { hands, groups: tableGroups } };
  },

  /**
   * I gruppi già completi, ciascuno con i soli membri PRESENTI in ordine
   * alfabetico: chi non si è mai collegato non compare fra i "salvati" (e se
   * arriva dopo, conta per sé: giusto → mezzo punteggio).
   */
  progress(table, answers, present) {
    return table.groups
      .filter((g) => isGroupComplete(table, g, answers, present))
      .map((g) => g.members.filter((id) => present.has(id)).sort());
  },

  /**
   * Alla chiusura. `completed` è l'insieme di chi sta in un gruppo completato
   * durante il round: un gruppo annunciato "salvato" in sala resta salvato.
   */
  resolve(rnd, ctx) {
    const { table, completed } = ctx;
    return {
      machineChoice: null,
      outcomeFor(optionIndex, playerId) {
        if (!isCorrect(table.hands, playerId, optionIndex)) return 'miss';
        return completed.has(playerId) ? 'complete' : 'half';
      },
      reveal: {
        groups: table.groups.map((g) => ({
          figure: g.figure,
          members: g.members.map((id) => ({ playerId: id, color: table.hands[id].color })),
        })),
      },
    };
  },

  /** Un giocatore di prova trova il compagno il 70% delle volte, sennò tira a caso. */
  botChoice(table, playerId, rnd) {
    const mine = table.hands[playerId];
    const partnerColors = Object.entries(table.hands)
      .filter(([id, card]) => id !== playerId && mine && card.figure === mine.figure)
      .map(([, card]) => card.color);
    if (partnerColors.length && rnd() < BOT_FINDS_PARTNER) {
      return partnerColors[Math.floor(rnd() * partnerColors.length)];
    }
    const others = this.options.map((_, c) => c).filter((c) => !mine || c !== mine.color);
    return others[Math.floor(rnd() * others.length)];
  },
};
