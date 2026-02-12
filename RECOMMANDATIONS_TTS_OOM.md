# Plan: Solution de Pré-Processing TTS pour Résoudre l'OOM

## Contexte

L'application OpenReader-Turtle sur Fly.io crashe cycliquement après ~40 secondes de lecture text-to-speech avec l'erreur:
```
Out of memory: Killed process 680 (next-server)
```

**Configuration actuelle:**
- VM: 2 CPUs shared, 4GB RAM (limite max pour 2 CPUs sur Fly.io)
- Problème: Génération TTS en direct consomme trop de mémoire
- Cycle: TTS 40s → OOM → restart → repeat

**Architecture TTS actuelle:**
1. Texte → découpage en blocks de max 450 caractères (`splitTextToTtsBlocks()`)
2. Chaque block → appel API `/api/tts` → génération audio → ArrayBuffer
3. ArrayBuffer → conversion base64 data URI → création Howl → playback
4. Cache LRU serveur: 256 MB, TTL 30 min
5. Cache LRU client: 50 items max en mémoire

## Recommandations

### Option 1: Augmenter la RAM à 8GB (Solution temporaire - NON RECOMMANDÉE)

**Avantages:**
- Rapide à implémenter (1 commande CLI)
- Aucun changement de code

**Inconvénients:**
- Coût 2x plus élevé (nécessite 4 CPUs pour avoir 8GB)
- Ne résout pas le problème fondamental
- Peut crasher quand même avec des documents plus longs
- Commande: `fly scale vm shared-cpu-4x --memory 8192 -a openreader-turtle`

**Verdict:** ❌ **Non recommandé** - solution coûteuse et temporaire

---

### Option 2: Solution de Pré-Processing TTS (RECOMMANDÉE)

Implémenter un système de pré-génération et stockage des chunks audio pour éviter les pics mémoire pendant la lecture.

#### Architecture Proposée

**1. Nouvelle structure de stockage**

Réutiliser l'infrastructure existante du docstore persistent:

```
/app/docstore/
  └── tts_cache_v1/              # Nouveau dossier pour TTS pré-généré
      └── {documentId}/           # Un dossier par document
          ├── tts.meta.json       # Métadonnées (voice, speed, model)
          └── chunks/             # Chunks audio
              ├── 0001__page-001__block-000.mp3
              ├── 0002__page-001__block-001.mp3
              └── ...
```

**2. Métadonnées (tts.meta.json)**

```json
{
  "documentId": "abc123",
  "ttsProvider": "openai",
  "ttsModel": "tts-1",
  "voice": "alloy",
  "nativeSpeed": 1.0,
  "createdAt": 1234567890,
  "chunks": [
    {
      "index": 0,
      "page": 1,
      "blockIndex": 0,
      "text": "First sentence...",
      "fileName": "0001__page-001__block-000.mp3",
      "duration": 3.5
    }
  ]
}
```

#### Modifications Requises

**Backend - Nouvelles Routes API**

1. **POST /api/tts/preprocess**
   - Pré-génère tous les chunks TTS pour un document
   - Sauvegarde dans `/tts_cache_v1/{documentId}/`
   - Retourne progression en temps réel

2. **GET /api/tts/preprocess/status?documentId={id}**
   - Vérifie si cache existe et si settings correspondent

3. **GET /api/tts/chunk?documentId={id}&page={page}&blockIndex={index}**
   - Retourne le fichier MP3 depuis le stockage
   - Streaming direct sans chargement en mémoire

4. **DELETE /api/tts/preprocess?documentId={id}**
   - Supprime le cache pour un document

**Frontend - Modifications UI**

1. **Nouveau composant: `PreprocessButton.tsx`**
   - Bouton dans la barre TTSPlayer
   - États: "Pré-générer" / "Pré-généré ✓" / "15/120 pages"
   - Modal de confirmation avec estimation stockage

2. **Modifications `TTSContext.tsx`**
   - Nouveau state: `preprocessMode: 'live' | 'cached'`
   - Fonction `checkPreprocessAvailability()` au chargement
   - Modification `getAudio()` pour charger depuis cache ou API
   - Fallback automatique vers mode live si chunk manquant

3. **Modifications `TTSPlayer.tsx`**
   - Intégration du `PreprocessButton`
   - Badge "Pré-généré ✓" quand cache disponible

#### Flow Utilisateur

1. **Détection automatique:**
   - Au chargement du document, vérifier si cache TTS existe
   - Si oui et settings correspondent → utiliser automatiquement

2. **Pré-génération manuelle:**
   - Clic "Pré-générer" → Modal avec estimation
   - Choix: "Tout le document" ou "Cette page seulement"
   - Barre de progression en temps réel
   - Stockage sur disque persistent

3. **Lecture:**
   - Mode cached: charge chunks depuis disque (10-50x plus rapide)
   - Mode live: génération TTS en direct (actuel)
   - Fallback automatique si chunk manquant

4. **Invalidation:**
   - Si voice/speed/model change → warning "Regénérer?"
   - Bouton "Nettoyer cache" dans settings

#### Gestion du Stockage

**Limite recommandée:** 5 GB pour `/tts_cache_v1/`

**Stratégie cleanup:**
- Background job vérifie taille totale périodiquement
- Si > 5 GB: supprimer les documents les plus anciens (par `createdAt`)
- Toujours garder le document actuellement ouvert

**Endpoint admin:** `GET /api/tts/preprocess/stats`
```json
{
  "totalSize": 4200000000,
  "documentsCount": 15,
  "oldestDocument": "2024-01-01T00:00:00Z"
}
```

#### Considérations Techniques

**Performance:**
- Lecture depuis disque: ~50-200ms par chunk
- TTS API call: ~2-5s par chunk
- **Amélioration: 10-50x plus rapide**

**Avantages mode cached:**
- Pas de pics mémoire (streaming direct depuis disque)
- Pas de limite rate API
- Lecture prévisible, pas de retry
- Résout définitivement l'OOM

**Inconvénients:**
- Utilise stockage disque (5 GB recommandé)
- Maintenance du cache nécessaire
- Doit regénérer si settings changent

#### Fichiers à Modifier

**Créations (nouveaux fichiers):**

1. `/src/app/api/tts/preprocess/route.ts`
   - Logique de pré-génération batch

2. `/src/app/api/tts/chunk/route.ts`
   - Streaming de chunks depuis disque

3. `/src/components/player/PreprocessButton.tsx`
   - Bouton UI pour pré-génération

4. `/src/hooks/audio/usePreprocessTTS.ts`
   - Hook pour gérer pré-génération

5. `/src/lib/server/tts-cache.ts`
   - Utilitaires serveur pour cache TTS

**Modifications (édition mineure):**

6. `/src/contexts/TTSContext.tsx`
   - Ajout state `preprocessMode` et logique fallback

7. `/src/components/player/TTSPlayer.tsx`
   - Intégration `PreprocessButton`

8. `/src/lib/server/docstore.ts`
   - Ajout constante `TTS_CACHE_V1_DIR`

#### Séquence d'Implémentation

**Phase 1: Infrastructure Backend (2-3h)**
1. Créer `/lib/server/tts-cache.ts` avec utilitaires
2. Créer `/api/tts/chunk/route.ts` pour streaming
3. Créer `/api/tts/preprocess/route.ts` pour génération

**Phase 2: Context et Logique (1-2h)**
4. Modifier `TTSContext.tsx` pour mode dual (live/cached)
5. Créer `usePreprocessTTS` hook

**Phase 3: UI (1h)**
6. Créer `PreprocessButton.tsx`
7. Intégrer dans `TTSPlayer.tsx`

**Phase 4: Testing (1-2h)**
8. Tests avec documents de différentes tailles
9. Monitoring mémoire
10. Cleanup automatique

**Durée totale estimée: 5-8 heures**

---

### Option 3: Solution Hybride (Compromis)

Combiner augmentation RAM modérée + optimisations mémoire:

1. **Augmenter à 4 CPUs / 8GB** temporairement
2. **Implémenter pré-processing page-by-page** (plus simple)
   - Pré-générer seulement page actuelle + suivante
   - Moins de stockage (~100 MB au lieu de 5 GB)
   - Plus rapide à implémenter (2-3h au lieu de 5-8h)
3. **Optimiser libération mémoire** dans le code existant

**Avantages:**
- Débloque immédiatement avec 8GB
- Optimisations réduisent consommation mémoire
- Peut revenir à 4GB après optimisations

**Inconvénients:**
- Coût plus élevé pendant transition
- Solution partielle

---

## Recommandation Finale

### Approche Recommandée: Option 2 (Pré-Processing TTS Complet)

**Pourquoi:**
1. ✅ Résout définitivement le problème d'OOM
2. ✅ Amélioration performance 10-50x
3. ✅ Pas d'augmentation de coût Fly.io
4. ✅ Meilleure expérience utilisateur (lecture instantanée)
5. ✅ Réutilise infrastructure existante (docstore, audiobook)

**Effort:** 5-8 heures d'implémentation

**ROI:** Excellent - résout le problème de fond et améliore l'expérience

### Alternative si Urgence: Option 3 (Hybride)

Si vous avez besoin d'une solution immédiate:
1. Augmenter temporairement à 8GB (15 minutes)
2. Implémenter pré-processing page-by-page (2-3h)
3. Revenir à 4GB une fois optimisé

---

## Plan de Vérification

Après implémentation, tester:

1. **Test fonctionnel:**
   - Ouvrir un document PDF > 100 pages
   - Cliquer "Pré-générer"
   - Vérifier progression en temps réel
   - Démarrer lecture → doit utiliser cache
   - Changer de voix → doit proposer regénération

2. **Test performance:**
   - Comparer temps de chargement: live vs cached
   - Monitorer utilisation mémoire (devrait rester < 2GB)
   - Vérifier aucun crash pendant lecture longue (> 10 min)

3. **Test stockage:**
   - Vérifier fichiers dans `/app/docstore/tts_cache_v1/`
   - Vérifier `tts.meta.json` correctement formé
   - Tester cleanup quand > 5GB

4. **Test edge cases:**
   - Document sans cache → fallback vers live
   - Cache incomplet → fallback chunks manquants
   - Changement settings → invalidation correcte

---

## Fichiers Critiques à Examiner

- `OpenReader-Turtle/src/app/api/tts/route.ts` - Pattern existant pour génération TTS
- `OpenReader-Turtle/src/contexts/TTSContext.tsx` - Cœur logique TTS à étendre
- `OpenReader-Turtle/src/lib/server/docstore.ts` - Infrastructure stockage
- `OpenReader-Turtle/src/app/api/audiobook/route.ts` - Pattern batch génération audio
- `OpenReader-Turtle/src/lib/nlp.ts` - Fonction `splitTextToTtsBlocks()`
- `OpenReader-Turtle/src/components/player/TTSPlayer.tsx` - UI à modifier

---

## Notes pour l'Agent Évaluateur

Cette solution:
- Réutilise au maximum le code existant
- S'inspire de l'infrastructure audiobook déjà en place
- Minimise les changements dans le flux TTS actuel
- Ajoute un mode "cached" en parallèle du mode "live"
- Permet fallback automatique pour compatibilité

**Complexité:** Modérée (5-8h)
**Impact:** Élevé (résout OOM définitivement)
**Risque:** Faible (changements isolés, fallback disponible)
