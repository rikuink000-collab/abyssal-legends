// pixelfx から ABYSSAL LEGENDS が使う部分だけを選ぶ入口。build.mjs が、pixelfx のクローンを基準にこのファイルをまとめる。
// 使うのは、描画の土台（フレーム・合成）と、第1弾の6つのエフェクトだけ。
// 人形（actor）を使うエフェクト・act.js・Patch Pixel フォントは使わない。
export { createFrame, clearFrame, createFx, composite } from "./src/core/index.js";
import * as hitSpark from "./src/fx/impacts/hit-spark.js";
import * as critHit from "./src/fx/impacts/crit-hit.js";
import * as poof from "./src/fx/spawn/poof.js";
import * as healAoe from "./src/fx/holy/heal-aoe.js";
import * as collectBurst from "./src/fx/pickups/collect-burst.js";
import * as chestOpen from "./src/fx/pickups/chest-open.js";
export const fx = { hitSpark, critHit, poof, healAoe, collectBurst, chestOpen };
