/**
 * Genera un data/comments.json realista para probar el pipeline sin token.
 * Uso: node test/make-fixture.mjs [cantidad]
 *
 * Mezcla a proposito los cuatro casos que el paso 3 tiene que distinguir.
 */
import { writeFile } from "node:fs/promises";

const TOTAL = Number(process.argv[2] ?? 500);
const OWNER = "cinthya";
const NOW = Date.now();

const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

const comments = Array.from({ length: TOTAL }, (_, i) => {
  const bucket = i % 10;

  // 1 de cada 10: no comento el keyword.
  if (bucket === 0) {
    return {
      id: `c_${i}`,
      username: `user_${i}`,
      text: "que buen video crack",
      timestamp: hoursAgo(1 + (i % 200)),
      replies: { data: [] },
    };
  }

  // 2 de cada 10: ManyChat ya los proceso (respuesta publica del owner).
  if (bucket === 1 || bucket === 2) {
    return {
      id: `c_${i}`,
      username: `user_${i}`,
      text: "30x",
      timestamp: hoursAgo(1 + (i % 200)),
      replies: {
        data: [{ id: `r_${i}`, username: OWNER, text: "Te acabo de enviar el link por DM!", timestamp: hoursAgo(1) }],
      },
    };
  }

  // 1 de cada 10: keyword pero ya fuera de la ventana de 7 dias.
  if (bucket === 3) {
    return {
      id: `c_${i}`,
      username: `user_${i}`,
      text: "quiero el 30X porfa",
      timestamp: hoursAgo(24 * 8 + (i % 48)),
      replies: { data: [] },
    };
  }

  // 1 de cada 10: respuesta del owner pero NO es la automatizacion -> sigue perdido.
  if (bucket === 4) {
    return {
      id: `c_${i}`,
      username: `user_${i}`,
      text: "30x!!",
      timestamp: hoursAgo(1 + (i % 150)),
      replies: { data: [{ id: `r_${i}`, username: OWNER, text: "gracias!! 🙏", timestamp: hoursAgo(1) }] },
    };
  }

  // El resto: perdidos, dentro de la ventana. Estos son los que hay que recuperar.
  return {
    id: `c_${i}`,
    username: `user_${i}`,
    text: i % 3 === 0 ? "30X" : "Quiero información 30x, cómo hago?",
    timestamp: hoursAgo(1 + (i % 160)),
    replies: { data: [] },
  };
});

const snapshot = {
  fetched_at: new Date().toISOString(),
  media: {
    id: "17900000000000000",
    shortcode: "FIXTURE001",
    permalink: "https://www.instagram.com/reel/FIXTURE001/",
    timestamp: hoursAgo(24 * 9),
    comments_count_reported: TOTAL + 12,
    comments_count_fetched: TOTAL,
  },
  comments,
};

await writeFile(new URL("../data/comments.json", import.meta.url), JSON.stringify(snapshot, null, 2), "utf8");
console.log(`Fixture: ${TOTAL} comentarios en data/comments.json`);
