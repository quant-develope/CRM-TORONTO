// Роли. Quant — владелец: добавляет людей и видит всё. КЦ (колл-центр) создаёт заявки и назначает водителей.
// Уборщик снега (водитель) видит только свои заявки. Роли видят только Quant и КЦ.
const ROLES = {
  quant: 'Quant',
  dispatcher: 'КЦ (оператор)',
  driver: 'Уборщик снега',
};

// Роли, которые Quant может выдать новому человеку.
const STAFF_ROLES = { dispatcher: ROLES.dispatcher, driver: ROLES.driver };

// Этапы заявки по порядку и цвет флажка.
const STATUS = {
  assigned: ['Назначена', 'blue'],
  accepted: ['Едет', 'turquoise'],
  arrived: ['На месте', 'orange'],
  started: ['В работе', 'lime'],
  done: ['Закончено, оплачено', 'green'],
  cancelled: ['Отменена', 'gray'],
};
const STEPS = ['assigned', 'accepted', 'arrived', 'started', 'done'];
// Пока заявка в одном из этих статусов, водитель в разделе «Заняты».
const ACTIVE = ['assigned', 'accepted', 'arrived', 'started'];

// card — перевод (трансфер); ключ оставлен прежним, чтобы не менять данные.
const PAY_METHODS = { cash: 'Наличные', card: 'Трансфер' };

const is = (user, ...roles) => Boolean(user) && roles.includes(user.role);

const can = {
  manageStaff: (u) => is(u, 'quant'),
  viewStaff: (u) => is(u, 'quant', 'dispatcher'),
  manageOrders: (u) => is(u, 'quant', 'dispatcher'),
  viewAuthLog: (u) => is(u, 'quant'),
};

module.exports = { ROLES, STAFF_ROLES, STATUS, STEPS, ACTIVE, PAY_METHODS, is, can };
