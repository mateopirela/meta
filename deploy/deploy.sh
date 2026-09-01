#!/usr/bin/env bash
# Build (Cloud Build, sin Docker local) + deploy a Cloud Run.
#
#   bash deploy/deploy.sh
#
# Decisiones que NO son opcionales:
#   --min-instances=1 --max-instances=1 --no-cpu-throttling
#     El envío corre en background dentro del proceso web durante horas. Sin CPU
#     siempre asignada Cloud Run lo congela entre requests; con más de una
#     instancia dos procesos podrían tomar el mismo job. Una instancia siempre
#     viva cuesta ~US$15/mes con 512Mi.
#   --allow-unauthenticated
#     La autenticación es de la app (Firebase, dominio 30x.com), no de Cloud Run
#     IAM: el browser llama al servicio directo, igual que prewave-web.
#   --set-secrets (modo en vivo)
#     El token de Meta y el App Secret NUNCA van en --set-env-vars: quedarían
#     visibles en `gcloud run services describe` y en la consola. Van por Secret
#     Manager, que deploy/setup.sh crea y al que le da acceso a la SA.
#   --memory 1Gi
#     Los ledgers del modo en vivo viven en memoria mientras las automatizaciones
#     están activas.
set -euo pipefail

PROJECT="${PROJECT:-prewave-prod}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-prewave-recovery}"
SA="${SA:-prewave-recovery@${PROJECT}.iam.gserviceaccount.com}"
BUCKET="${BUCKET:-prewave-recovery-jobs}"
REPO="${REPO:-us-central1-docker.pkg.dev/${PROJECT}/containers}"

# El proyecto de Firebase de PreWave ES el proyecto de GCP (prewave-prod), desde
# ago-2026. El viejo `prewave-prod-f1303` ya no existe: con esa apiKey el popup
# de Google falla con auth/api-key-not-valid. La apiKey web es publica (va en el
# bundle de prewave-web); esta es la "Browser key (auto created by Firebase)".
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-prewave-prod}"
FIREBASE_AUTH_DOMAIN="${FIREBASE_AUTH_DOMAIN:-prewave-prod.firebaseapp.com}"
FIREBASE_API_KEY="${FIREBASE_API_KEY:-AIzaSyBT-KIA8XZzu1taoX8B3CtGLSz3JXpOeTE}"
AUTH_ALLOWED_DOMAINS="${AUTH_ALLOWED_DOMAINS:-30x.com}"

TAG="$(date -u +%Y%m%d-%H%M%S)"
IMAGE="${REPO}/${SERVICE}:${TAG}"

cd "$(dirname "$0")/.."

echo "→ Tests"
npm test --silent

echo "→ Build en Cloud Build: $IMAGE"
gcloud builds submit --tag "$IMAGE" --project "$PROJECT" --quiet .

echo "→ Deploy a Cloud Run: $SERVICE"
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --project "$PROJECT" --region "$REGION" \
  --platform managed \
  --service-account "$SA" \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 --no-cpu-throttling \
  --cpu 1 --memory 1Gi --concurrency 40 --timeout 300 \
  --port 8080 \
  --set-env-vars "JOBS_BUCKET=${BUCKET},AUTH_REQUIRED=true,FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID},FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN},FIREBASE_API_KEY=${FIREBASE_API_KEY},AUTH_ALLOWED_DOMAINS=${AUTH_ALLOWED_DOMAINS},LIVE_ENABLED=true,LIVE_POLL_INTERVAL_MS=20000" \
  --set-secrets "META_SYSTEM_USER_TOKEN=meta-system-user-token:latest,META_APP_SECRET=meta-app-secret:latest,META_WEBHOOK_VERIFY_TOKEN=meta-webhook-verify-token:latest" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo
echo "Desplegado: $URL"
echo
echo "Si es el primer deploy, agregá el dominio del servicio a Firebase Auth →"
echo "Authentication → Settings → Authorized domains:"
echo "  ${URL#https://}"
echo "Sin eso, el popup de Google dice 'unauthorized-domain'."
