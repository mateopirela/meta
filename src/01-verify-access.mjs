/**
 * PASO 1 — ¿Podemos enviar?
 *
 * Read-only. Lista las paginas que el token administra y dice si la cuenta de
 * Cinthya esta entre ellas. Si no lo esta, TODO lo demas es imposible: el
 * private_reply exige un Page Token de la pagina duena del post.
 *
 * Corre esto ANTES que nada.
 */
import { loadConfig } from "./config.mjs";
import { listManagedPages, getPageToken, GraphError } from "./meta.mjs";

const config = loadConfig(["META_TOKEN_MARKETING_INTEGRATION", "IG_USERNAME"]);

const main = async () => {
  console.log("\nConsultando /me/accounts...\n");

  let pages;
  try {
    pages = await listManagedPages(config);
  } catch (err) {
    if (err instanceof GraphError && (err.code === 190 || err.status === 401)) {
      console.error("Token invalido o expirado (#190). Hay que regenerarlo en el BM.\n");
      process.exit(1);
    }
    throw err;
  }

  if (pages.length === 0) {
    console.error("El token no administra NINGUNA pagina. Casi seguro le faltan scopes.\n");
    process.exit(1);
  }

  console.log(`El token administra ${pages.length} pagina(s):\n`);
  for (const page of pages) {
    const ig = page.instagram_business_account;
    const igLabel = ig ? `@${ig.username} (IG id ${ig.id})` : "sin cuenta de IG vinculada";
    console.log(`  - ${page.name} [page ${page.id}] -> ${igLabel}`);
  }

  const target = pages.find(
    (p) => p.instagram_business_account?.username?.toLowerCase() === config.igUsername.toLowerCase(),
  );

  console.log("\n" + "-".repeat(70));

  if (!target) {
    console.error(
      `\nBLOQUEADO: @${config.igUsername} no esta entre las paginas que el token administra.\n\n` +
        "No se puede enviar el DM. Opciones:\n" +
        "  a) Agregar la pagina de FB de Cinthya a nuestro Business Manager, o\n" +
        "  b) Conseguir un Page Access Token de esa pagina.\n\n" +
        "Hasta entonces solo se puede llegar al CSV clasificado (lectura via CDP).\n",
    );
    process.exit(2);
  }

  console.log(`\nEncontrada: @${config.igUsername} -> pagina "${target.name}" [${target.id}]`);
  console.log("Probando derivar el Page Access Token...");

  try {
    const pageToken = await getPageToken(target.id, config);
    console.log(`Page token OK (${pageToken.length} chars, no se imprime).`);
  } catch (err) {
    console.error(`\nNo se pudo derivar el Page Token: ${err.message}`);
    console.error("El token ve la pagina pero no puede actuar sobre ella. Revisar scopes.\n");
    process.exit(2);
  }

  console.log("\nVERDE: se puede leer y enviar.\n");
  console.log("Guarda estos valores en .env para los pasos siguientes:\n");
  console.log(`  PAGE_ID=${target.id}`);
  console.log(`  IG_USER_ID=${target.instagram_business_account.id}\n`);
};

main().catch((err) => {
  console.error("\nError inesperado:", err.message);
  if (err instanceof GraphError) console.error("Detalle Meta:", JSON.stringify(err.raw, null, 2));
  process.exit(1);
});
