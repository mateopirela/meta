#!/usr/bin/env bash
# Infra de UNA sola vez para prewave-recovery: service account + bucket de jobs.
# Idempotente: si algo ya existe, sigue.
#
#   bash deploy/setup.sh
set -euo pipefail

PROJECT="${PROJECT:-prewave-prod}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-prewave-recovery}"
SA_NAME="${SA_NAME:-prewave-recovery}"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
BUCKET="${BUCKET:-prewave-recovery-jobs}"

echo "Proyecto $PROJECT · región $REGION · servicio $SERVICE"

echo "→ APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com \
  --project "$PROJECT" --quiet

echo "→ Service account $SA"
if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT" \
    --display-name "Recuperación de DMs (Cloud Run)"
fi

echo "→ Bucket gs://$BUCKET (privado, acceso uniforme, versionado)"
if ! gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention
  # Versionado: si un job se pisa por error, la version anterior sigue ahi.
  gcloud storage buckets update "gs://$BUCKET" --versioning
fi

echo "→ La SA puede leer/escribir SOLO en ese bucket"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:$SA" --role roles/storage.objectAdmin --project "$PROJECT" --quiet >/dev/null

echo "→ Secretos del modo en vivo (Secret Manager)"
# Los tres nacen con un valor placeholder para que `--set-secrets ...:latest`
# resuelva en el primer deploy. El de verdad se carga despues:
#   printf '%s' '<valor>' | gcloud secrets versions add <secreto> --project PROJECT --data-file=-
for S in meta-system-user-token meta-app-secret meta-webhook-verify-token; do
  gcloud secrets describe "$S" --project "$PROJECT" >/dev/null 2>&1 || \
    gcloud secrets create "$S" --project "$PROJECT" --replication-policy automatic

  # Sin ninguna version, el deploy falla al resolver `latest`.
  if ! gcloud secrets versions list "$S" --project "$PROJECT" --limit 1 --format 'value(name)' | grep -q .; then
    case "$S" in
      # "unset" apaga el webhook a proposito: hasta que el dueño de la cuenta
      # pegue el App Secret real, POST /webhooks/meta responde 503.
      meta-app-secret) VALUE="unset" ;;
      # Este lo inventamos nosotros: es el string del handshake con Meta.
      meta-webhook-verify-token) VALUE="$(openssl rand -hex 16)" ;;
      *) VALUE="unset" ;;
    esac
    printf '%s' "$VALUE" | gcloud secrets versions add "$S" --project "$PROJECT" --data-file=- >/dev/null
    echo "   $S: version inicial creada"
  fi

  gcloud secrets add-iam-policy-binding "$S" --project "$PROJECT" \
    --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null
done

echo
echo "Cargá el System User token (sin esto el modo en vivo queda apagado):"
echo "  printf '%s' '<token>' | gcloud secrets versions add meta-system-user-token --project $PROJECT --data-file=-"
echo "El verify token para pegar en el dashboard de Meta:"
echo "  gcloud secrets versions access latest --secret meta-webhook-verify-token --project $PROJECT"

echo
echo "Listo. Siguiente: bash deploy/deploy.sh"
