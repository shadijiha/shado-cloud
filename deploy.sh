pm2 stop "shado-cloud-backend"
git pull
npm install
npm run build
npm run typeorm:generate -- -n "hehexd".
npm run build
npm run typeorm:migrate
pm2 restart "shado-cloud-backend"