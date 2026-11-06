// API 冒烟测试：先启动 npm start，再 node scripts/smoke-api.js
const base = process.argv[2] || 'http://192.168.1.111:3000';

async function getJson(path, opts) {
	const r = await fetch(base + path, opts);
	const j = await r.json().catch(() => null);
	console.log(`\n[${path}] HTTP ${r.status}`);
	console.log(JSON.stringify(j).slice(0, 300));
	return j;
}

async function main() {
	await getJson('/api/health');
	await getJson('/api/home');
	await getJson('/api/categories');
	const list = await getJson('/api/novels?pageSize=5');

	const novelId = list?.data?.list?.[0]?.id;
	if (novelId) {
		await getJson(`/api/novels/${novelId}`);
		const chapters = await getJson(`/api/novels/${novelId}/chapters`);
		const chapterId = chapters?.data?.[0]?.id;
		if (chapterId) await getJson(`/api/chapters/${chapterId}`);
	}

	// 登录（mock）
	const r = await fetch(base + '/api/auth/login', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code: 'devtest', deviceId: 'devtest' })
	});
	const lj = await r.json();
	console.log('\n[POST /api/auth/login] HTTP', r.status);
	console.log(JSON.stringify(lj).slice(0, 200));
	const token = lj?.data?.token;

	if (token) {
		const auth = {
			'content-type': 'application/json',
			authorization: `Bearer ${token}`
		};
		await fetch(base + '/api/bookshelf', {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ novelId })
		});
		await getJson('/api/bookshelf', {
			headers: { authorization: `Bearer ${token}` }
		});
	}
}

main().catch((e) => {
	console.error('冒烟测试失败（确认已启动 npm start）:', e.message);
	process.exit(1);
});
