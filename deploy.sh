pm2 stop "shado-cloud-backend"
git pull
npm install
npm run build
pm2 restart "shado-cloud-backend"