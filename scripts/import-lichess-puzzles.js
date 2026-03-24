#!/usr/bin/env node
/**
 * Import Lichess puzzle database into chess-puzzles.json seed file.
 *
 * Usage:
 *   node scripts/import-lichess-puzzles.js [path-to-lichess_db_puzzle.csv]
 *
 * If no path given, downloads from database.lichess.org (requires curl + zstd).
 * Re-runnable: overwrites the existing seed file each time.
 *
 * Lichess puzzle CSV format:
 *   PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags
 *
 * Moves are space-separated UCI. The first move is the "setup" move (opponent's
 * last move). Remaining moves alternate: player, opponent, player, ...
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, '..', 'server', 'seeds', 'chess-puzzles.json');

// Target counts per difficulty tier
const TARGETS = { easy: 300, medium: 400, hard: 300 };

// Rating → difficulty mapping
function ratingToDifficulty(rating) {
  if (rating < 1200) return 'easy';
  if (rating <= 1800) return 'medium';
  return 'hard';
}

// Lichess theme → display theme mapping (pick the most descriptive theme)
const THEME_DISPLAY = {
  mate: 'Checkmate', mateIn1: 'Mate in 1', mateIn2: 'Mate in 2',
  mateIn3: 'Mate in 3', mateIn4: 'Mate in 4', mateIn5: 'Mate in 5',
  backRankMate: 'Back rank mate', hookMate: 'Hook mate',
  smotheredMate: 'Smothered mate', arabianMate: 'Arabian mate',
  bodenMate: 'Boden mate', anastasiasMate: 'Anastasia mate',
  doubleBishopMate: 'Double bishop mate', dovetailMate: 'Dovetail mate',
  fork: 'Fork', pin: 'Pin', skewer: 'Skewer',
  discoveredAttack: 'Discovered attack', doubleCheck: 'Double check',
  sacrifice: 'Sacrifice', deflection: 'Deflection', decoy: 'Decoy',
  attraction: 'Attraction', clearance: 'Clearance',
  hangingPiece: 'Hanging piece', trappedPiece: 'Trapped piece',
  crushing: 'Winning move', advantage: 'Find the best move',
  quietMove: 'Quiet move', defensiveMove: 'Defensive move',
  zugzwang: 'Zugzwang', interference: 'Interference',
  intermezzo: 'Intermezzo', xRayAttack: 'X-ray attack',
  castling: 'Castling', enPassant: 'En passant',
  promotion: 'Promotion', underPromotion: 'Underpromotion',
  kingsideAttack: 'Kingside attack', queensideAttack: 'Queenside attack',
};

// Pick the best display theme from a list of Lichess themes
function pickTheme(themes) {
  // Priority order: specific mate patterns > tactics > general
  const priority = [
    'mateIn1', 'mateIn2', 'mateIn3', 'backRankMate', 'smotheredMate',
    'hookMate', 'arabianMate', 'bodenMate', 'anastasiasMate',
    'fork', 'pin', 'skewer', 'discoveredAttack', 'doubleCheck',
    'sacrifice', 'deflection', 'decoy', 'attraction', 'clearance',
    'zugzwang', 'interference', 'intermezzo', 'xRayAttack',
    'promotion', 'underPromotion', 'enPassant', 'castling',
    'quietMove', 'defensiveMove', 'hangingPiece', 'trappedPiece',
    'kingsideAttack', 'queensideAttack', 'mate', 'crushing', 'advantage',
  ];
  for (const t of priority) {
    if (themes.includes(t)) return THEME_DISPLAY[t] || t;
  }
  return 'Find the best move';
}

// ── FEN move application ────────────────────────────────────────────────────

function parseFenBoard(boardStr) {
  const board = [];
  for (const row of boardStr.split('/')) {
    const r = [];
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < parseInt(ch); i++) r.push(null);
      } else {
        r.push(ch);
      }
    }
    board.push(r);
  }
  return board;
}

function boardToFenStr(board) {
  let fen = '';
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      if (board[r][c] === null) {
        empty++;
      } else {
        if (empty > 0) { fen += empty; empty = 0; }
        fen += board[r][c];
      }
    }
    if (empty > 0) fen += empty;
    if (r < 7) fen += '/';
  }
  return fen;
}

/**
 * Apply a UCI move to a FEN string, returning the new FEN.
 * Handles: basic moves, captures, en passant, castling, promotion.
 */
function applyUciMove(fen, uciMove) {
  const parts = fen.split(' ');
  const board = parseFenBoard(parts[0]);
  const turn = parts[1] || 'w';
  let castling = parts[2] || '-';
  const enPassant = parts[3] || '-';
  const halfmove = parseInt(parts[4] || '0');
  const fullmove = parseInt(parts[5] || '1');

  const fromCol = uciMove.charCodeAt(0) - 97;
  const fromRow = 8 - parseInt(uciMove[1]);
  const toCol = uciMove.charCodeAt(2) - 97;
  const toRow = 8 - parseInt(uciMove[3]);
  const promotion = uciMove[4]; // optional, e.g. 'q'

  const piece = board[fromRow][fromCol];
  if (!piece) {
    // Invalid move — piece not found at source; return FEN unchanged
    return fen;
  }
  const captured = board[toRow][toCol];
  const isWhite = piece === piece.toUpperCase();

  // En passant capture
  if (piece.toLowerCase() === 'p' && fromCol !== toCol && !captured) {
    board[fromRow][toCol] = null; // remove captured pawn
  }

  // Castling (king moves 2+ squares horizontally)
  if (piece.toLowerCase() === 'k' && Math.abs(fromCol - toCol) === 2) {
    if (toCol > fromCol) {
      // King-side
      board[fromRow][5] = board[fromRow][7];
      board[fromRow][7] = null;
    } else {
      // Queen-side
      board[fromRow][3] = board[fromRow][0];
      board[fromRow][0] = null;
    }
  }

  // Move piece
  if (promotion) {
    board[toRow][toCol] = isWhite ? promotion.toUpperCase() : promotion.toLowerCase();
  } else {
    board[toRow][toCol] = piece;
  }
  board[fromRow][fromCol] = null;

  // Update castling rights
  if (piece === 'K') castling = castling.replace(/[KQ]/g, '');
  if (piece === 'k') castling = castling.replace(/[kq]/g, '');
  if (piece === 'R' && fromRow === 7 && fromCol === 7) castling = castling.replace('K', '');
  if (piece === 'R' && fromRow === 7 && fromCol === 0) castling = castling.replace('Q', '');
  if (piece === 'r' && fromRow === 0 && fromCol === 7) castling = castling.replace('k', '');
  if (piece === 'r' && fromRow === 0 && fromCol === 0) castling = castling.replace('q', '');
  // Rook captured on its starting square
  if (toRow === 0 && toCol === 7) castling = castling.replace('k', '');
  if (toRow === 0 && toCol === 0) castling = castling.replace('q', '');
  if (toRow === 7 && toCol === 7) castling = castling.replace('K', '');
  if (toRow === 7 && toCol === 0) castling = castling.replace('Q', '');
  if (castling === '') castling = '-';

  // En passant target square
  let newEnPassant = '-';
  if (piece.toLowerCase() === 'p' && Math.abs(fromRow - toRow) === 2) {
    const epRow = (fromRow + toRow) / 2;
    newEnPassant = String.fromCharCode(97 + fromCol) + (8 - epRow);
  }

  // Half-move clock
  const newHalfmove = (piece.toLowerCase() === 'p' || captured) ? 0 : halfmove + 1;
  const newFullmove = turn === 'b' ? fullmove + 1 : fullmove;
  const newTurn = turn === 'w' ? 'b' : 'w';

  return `${boardToFenStr(board)} ${newTurn} ${castling} ${newEnPassant} ${newHalfmove} ${newFullmove}`;
}

// ── CSV Parsing ─────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  // Simple CSV parser that handles the Lichess format (no quoted fields with commas)
  return line.split(',');
}

function processCSV(csvContent) {
  const lines = csvContent.split('\n').filter(l => l.trim());
  // Skip header
  const header = lines[0];
  if (!header.startsWith('PuzzleId')) {
    console.error('Unexpected CSV format — missing PuzzleId header');
    process.exit(1);
  }

  const buckets = { easy: [], medium: [], hard: [] };
  const allFull = () => Object.keys(TARGETS).every(d => buckets[d].length >= TARGETS[d]);

  for (let i = 1; i < lines.length; i++) {
    if (allFull()) break;

    const fields = parseCSVLine(lines[i]);
    if (fields.length < 9) continue;

    const [puzzleId, fen, movesStr, ratingStr, ratingDevStr, popularityStr, nbPlaysStr, themes] = fields;

    const rating = parseInt(ratingStr);
    const ratingDev = parseInt(ratingDevStr);
    const popularity = parseInt(popularityStr);
    const nbPlays = parseInt(nbPlaysStr);
    const moves = movesStr.split(' ');

    // Filter criteria
    if (ratingDev > 100) continue;          // Skip uncertain ratings
    if (popularity < 70) continue;           // Skip unpopular puzzles
    if (nbPlays < 1000) continue;            // Skip rarely-played puzzles
    if (moves.length < 2) continue;          // Need at least setup + 1 player move
    if (moves.length > 8) continue;          // Skip very long puzzles (>4 player moves)

    const difficulty = ratingToDifficulty(rating);
    if (buckets[difficulty].length >= TARGETS[difficulty]) continue;

    // Apply setup move to get the puzzle position
    const setupMove = moves[0];
    const puzzleFen = applyUciMove(fen, setupMove);

    // Extract player moves (odd indices) and opponent responses (even indices after setup)
    const playerMoves = [];
    const opponentMoves = [];
    for (let m = 1; m < moves.length; m++) {
      if (m % 2 === 1) {
        playerMoves.push(moves[m]);
      } else {
        opponentMoves.push(moves[m]);
      }
    }

    const themeList = themes.split(' ').filter(Boolean);
    const displayTheme = pickTheme(themeList);

    // Determine prompt based on move count
    let prompt;
    if (playerMoves.length === 1) {
      prompt = `${displayTheme}: Find the winning move`;
    } else {
      prompt = `${displayTheme}: Find the winning sequence (${playerMoves.length} moves)`;
    }

    buckets[difficulty].push({
      lichessId: puzzleId,
      fen: puzzleFen,
      solution: playerMoves.join(','),
      opponentMoves: opponentMoves.length > 0 ? opponentMoves : undefined,
      theme: displayTheme,
      difficulty,
      rating,
    });
  }

  // Combine all buckets
  const puzzles = [...buckets.easy, ...buckets.medium, ...buckets.hard];
  console.log(`Selected: easy=${buckets.easy.length}, medium=${buckets.medium.length}, hard=${buckets.hard.length}, total=${puzzles.length}`);
  return puzzles;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  let csvPath = process.argv[2];

  if (!csvPath) {
    // Try to download a sample from Lichess
    console.log('No CSV path provided — downloading sample from database.lichess.org...');
    console.log('(For full import, download lichess_db_puzzle.csv.zst and pass the decompressed path)');

    const tmpPath = '/tmp/lichess_puzzles_import.csv';
    try {
      execSync(
        `curl -s --max-time 60 https://database.lichess.org/lichess_db_puzzle.csv.zst | zstd -d 2>/dev/null | head -50001 > ${tmpPath}`,
        { stdio: ['pipe', 'pipe', 'pipe'], timeout: 90_000 }
      );
      csvPath = tmpPath;
      console.log('Downloaded sample successfully.');
    } catch (err) {
      console.error('Download failed. Please provide a local CSV path.');
      console.error('Download the file from: https://database.lichess.org/lichess_db_puzzle.csv.zst');
      console.error('Decompress with: zstd -d lichess_db_puzzle.csv.zst');
      console.error('Then run: node scripts/import-lichess-puzzles.js lichess_db_puzzle.csv');
      process.exit(1);
    }
  }

  if (!existsSync(csvPath)) {
    console.error(`File not found: ${csvPath}`);
    process.exit(1);
  }

  console.log(`Reading ${csvPath}...`);
  const csvContent = readFileSync(csvPath, 'utf-8');
  const puzzles = processCSV(csvContent);

  // Write seed file (without lichessId and rating — those are import metadata only)
  const seedData = puzzles.map(p => {
    const entry = {
      fen: p.fen,
      solution: p.solution,
      theme: p.theme,
      difficulty: p.difficulty,
    };
    if (p.opponentMoves) {
      entry.opponentMoves = p.opponentMoves;
    }
    return entry;
  });

  writeFileSync(SEED_PATH, JSON.stringify(seedData, null, 2) + '\n');
  console.log(`Wrote ${seedData.length} puzzles to ${SEED_PATH}`);

  // Print stats
  const multiMove = seedData.filter(p => p.solution.includes(','));
  console.log(`Single-move puzzles: ${seedData.length - multiMove.length}`);
  console.log(`Multi-move puzzles: ${multiMove.length}`);
}

main();
