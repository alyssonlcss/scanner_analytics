const cp = require('child_process');
try {
  cp.execSync('start msedge "http://elabziplra00.enelint.global:8090/spotfire/wp/analysis?file=/M300/Scanner%204.0%20-%20CE&waid=123"');
  console.log("SUCCESS");
} catch(e) {
  console.log("FAIL", e.message);
}
