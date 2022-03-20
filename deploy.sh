date=$(date'+%Y-%m-%d%H-%M-%S')

pm2 stop "shado-cloud-backend"
git pull
npm install
npm run build
npm run typeorm:generate -- -n $date.
npm run typeorm:migrate
npm run build
pm2 restart "shado-cloud-backend"