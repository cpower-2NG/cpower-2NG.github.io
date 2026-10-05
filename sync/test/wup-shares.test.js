import assert from 'node:assert/strict';
import test from 'node:test';
import { extractWupShares, gtkFromCookies } from '../src/qzone-shares.js';

// 真实转发条目（2026-10-05 侦察样本）的结构缩略版：字段与标签保持原样。
const REPOST_BLOCK = `
<li class="f-single f-s-s" id="fct_2967399604_202_2_1791124124_0_1"> <div class="f-single-head">…
  <div class="user-info"> <a class="f-name q_namecard">2NG仙人星</a> <span class="state"> 昨天 22:28 </span></div>
  <div class="f-item" id="feed_2967399604_202_2_1791124124_0_1" data-key="ecbecbbjhb">
    <div class="f-info">    怀念	    </div>
    <div class="qz_summary wupfeed" id="hex_2967399604_202_2_1791124124_0_1" data-titlelen="45" data-contentlen="36">
      <i class="none" name="feed_data" data-fkey="ecbecbbjhb" data-tid="1791124124" data-uin="2967399604"
         data-feedstype="100" data-abstime="1791124124" data-iswupfeed="1"></i>
      <div class="f-ct"> <div class="img-box"><a href="https://www.bilibili.com/video/BV1VLHE6hEpE/?vd_source=abc&amp;share_source=qqzone" target="_blank"><img src="https://a1.qpic.cn/cover"></a></div>
        <div class="txt-box"> <h4 class="txt-box-title t-fixed"><a href="https://www.bilibili.com/video/BV1VLHE6hEpE/?vd_source=abc">回去妇儿剧场看凉本秋穗FMT一周年</a></h4>
          <a href="https://www.bilibili.com/video/BV1VLHE6hEpE/?vd_source=abc" class=" f-name info state ellipsis-two" > 不愧是妇儿剧场，全是小孩 </a>
        </div>
      </div>
    </div>
  </div>
</li>`;

const PLAIN_MOOD_BLOCK = `
<li class="f-single f-s-s" id="fct_2967399604_311_2_1791000000_0_1">
  <div class="f-info">普通说说没有视频卡片</div>
  <i name="feed_data" data-fkey="b4ecdeb0ec3fbe6a9dd20b00" data-abstime="1791000000" data-uin="2967399604"></i>
</li>`;

test('extractWupShares 从 HTML 提取视频卡片转发', () => {
  const shares = extractWupShares(`<div>${REPOST_BLOCK}${PLAIN_MOOD_BLOCK}</div>`);
  assert.equal(shares.length, 1);
  const share = shares[0];
  assert.equal(share.shareId, 'ecbecbbjhb');
  assert.equal(share.bvid, 'BV1VLHE6hEpE');
  assert.equal(share.createdAt, new Date(1791124124 * 1000).toISOString());
  assert.equal(share.url, 'https://www.bilibili.com/video/BV1VLHE6hEpE/');
  assert.equal(share.text, '怀念\n\n不愧是妇儿剧场，全是小孩');
  assert.equal(share.authorId, '2967399604');
});

test('extractWupShares 跳过无视频卡片的条目并按 fkey 去重', () => {
  assert.equal(extractWupShares(PLAIN_MOOD_BLOCK).length, 0);
  const duplicated = `${REPOST_BLOCK}${REPOST_BLOCK}`;
  assert.equal(extractWupShares(duplicated).length, 1);
  assert.deepEqual(extractWupShares(''), []);
});

test('gtkFromCookies 优先 p_skey，兼容 skey', () => {
  assert.equal(gtkFromCookies({ p_skey: 'abc' }), gtkFromCookies({ skey: 'abc', p_skey: 'abc' }));
  assert.notEqual(gtkFromCookies({ skey: 'abc' }), 0);
});
