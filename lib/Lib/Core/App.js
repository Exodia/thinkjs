var cluster = require("cluster");
var fs = require("fs");
var domain = require("domain");
var thinkHttp = thinkRequire("Http");
var Dispatcher = thinkRequire('Dispatcher');

/**
 * 应用程序
 * @type {Object}
 */
var App = module.exports = Class(function(){
	"use strict";
	//controller和action的校验正则
	var nameReg = /^[A-Za-z\_](\w)*$/;
	//注释的正则
	var commentReg = /((\/\/.*$)|(\/\*[\s\S]*?\*\/)|(\s))/mg;
	//获取形参的正则
	var parsReg = /^function\s*[^\(]*\(\s*([^\)]*)\)/m;

	return {
		init: function(http){
			this.http = http;
		},
		/**
		 * 解析路由
		 * @return {[type]} [description]
		 */
		dispatch: function(){
			return Dispatcher(this.http).run();
		},
		/**
		 * 获取controller
		 * @return {[type]} [description]
		 */
		getController: function(){
			var group = this.http.group;
			var controller = '';
			//检测controller名
			if (!nameReg.test(this.http.controller)) {
				controller = '';
			}else{
				controller = A(group + "/" + this.http.controller, this.http);
				if (controller) {
					return controller;
				}
			}
			var controllerConf = C('call_controller');
			if (controllerConf) {
				if (isString(controllerConf)) {
					controllerConf = controllerConf.split(":");
				}
				var action = Dispatcher.getAction(controllerConf.pop());
				controller = Dispatcher.getController(controllerConf.pop());
				group = Dispatcher.getGroup(controllerConf.pop());
				controller = A(group + "/" + controller, this.http);
				if (controller && typeof controller[action + C('action_suffix')] === 'function') {
					this.http.group = group;
					this.http.controller = controller;
					this.http.action = action;
					return controller;
				}
			}
		},
		/**
		 * 执行
		 * @return {[type]} [description]
		 */
		exec: function(){
			var controller = this.getController();
			if (!controller) {
				return getPromise(new Error("Controller `" + this.http.controller + "` not found"), true);
			}
			var self = this;
			var action = this.http.action;
			var act = action;
			//添加action后缀
			action += C('action_suffix') || "";
			//检测action名
			if (!nameReg.test(action)) {
				return getPromise(new Error('action `' + act + '` is not valid'), true);
			}
			var initReturnPromise = getPromise(controller.__initReturn);
			//对应的action方法存在
			if (typeof controller[action] === 'function') {
				//方法参数自动绑定，直接从形参里拿到对应的值
				if (C('url_params_bind')) {
					var toString = controller[action].toString();
					toString = toString.replace(commentReg, '');
					var match = toString.match(parsReg)[1].split(/,/).filter(function(item){
						return item;
					});
					//匹配到形参
					if (match && match.length) {
						var data = [];
						match.forEach(function(item){
							var value = self.http.post[item] || self.http.get[item] || "";
							data.push(value);
						});
						return initReturnPromise.then(function(){
							return self.execAction(controller, action, act, data);
						});
					}
				}
				return initReturnPromise.then(function(){
					return self.execAction(controller, action, act);
				});
			}else{
				//当指定的方法不存在时，调用魔术方法
				//默认为__call方法
				var callMethod = C('call_method');
				if (callMethod && typeof controller[callMethod] === 'function') {
					return initReturnPromise.then(function(){
						return controller[callMethod](act, action);
					});
				}
			}
			return getPromise(new Error("action `" + action + "` not found"), true);
		},
		/**
		 * 执行一个action, 支持before和after的统一操作
		 * 不对每个action都增加一个before和after，而是使用统一的策略
		 * 默认before和after调用名__before和__after
		 * @param  {[type]} controller [description]
		 * @param  {[type]} action     [description]
		 * @param  {[type]} act  [description]
		 * @param  {[type]} data       [description]
		 * @return {[type]}            [description]
		 */
		execAction: function(controller, action, act, data){
			var promise = getPromise();
			//before action
			var before = C('before_action_name');
			if (before && typeof controller[before] === 'function') {
				promise = getPromise(controller[before](act, action));
			}
			return promise.then(function(){
				var ret = data ? controller[action].apply(controller, data) : controller[action]();
				return getPromise(ret);
			}).then(function(){
				//after action
				var after = C('after_action_name');
				if (after && typeof controller[after] === 'function') {
					return controller[after](act, action);
				}
			});
		},
		/**
		 * 发送错误信息
		 * @param  {[type]} error [description]
		 * @return {[type]}       [description]
		 */
		sendError: function(error){
			var message = isError(error) ? error.stack : error;
			var http = this.http;
			console.log(message);
			if (!http.res) {
				return;
			}
			if (APP_DEBUG) {
				http.res.end(message);
			}else{
				http.setHeader('Content-Type', 'text/html; charset=' + C('encoding'));
				var readStream = fs.createReadStream(C('error_tpl_path'));
				readStream.pipe(http.res);
				readStream.on("end", function(){
					http.res.end();
				});
			}
		}
	};
});

/**
 * run
 * @return {[type]} [description]
 */
App.run = function(){
	"use strict";
	if (APP_MODE && App.mode[APP_MODE]) {
		return App.mode[APP_MODE]();
	}
	return App.mode._default();
};
/**
 * 不同模式下的run
 * @type {Object}
 */
App.mode = {
	//命令行模式
	cli: function(){
		"use strict";
		var defaultHttp = thinkHttp.getDefaultHttp(APP_MODE_DATA);
		thinkHttp(defaultHttp.req, defaultHttp.res).run(App.listener);
	},
	//默认模式
	_default: function(){
		"use strict";
		var clusterNums = C('use_cluster');
		//不使用cluster
		if (!clusterNums) {
			return App.createServer();
		}
		//使用cpu的个数
		if (clusterNums === true) {
			clusterNums = require('os').cpus().length;
		}
		if (cluster.isMaster) {
			for (var i = 0; i < clusterNums; i++) {
				cluster.fork();
			}
			cluster.on('exit', function(worker) {
				console.log('worker ' + worker.process.pid + ' died');
				process.nextTick(function(){
					cluster.fork();
				});
			});
		}else {
			App.createServer();
		}
	}
};
/**
 * 创建服务
 * @return {[type]} [description]
 */
App.createServer = function(){
	"use strict";
	//自定义创建server
	var createServerFn = C('create_server_fn');
	if (createServerFn && typeof global[createServerFn] === 'function') {
		return global[createServerFn](App);
	}
	var server = require("http").createServer(function (req, res) {
		thinkHttp(req, res).run(App.listener);
	});
	var params = [C('port')];
	//禁止外网直接通过IP访问
	if (C('deny_remote_access_by_ip')) {
		params.push("127.0.0.1");
	}
	App.webSocket(server);
	server.listen.apply(server, params);
};
/**
 * webSocket
 * @param  {[type]} server [description]
 * @return {[type]}        [description]
 */
App.webSocket = function(server){
	"use strict";
	if (!C('use_websocket')) {
		return;
	}
	var WebSocket = require('faye-websocket');
	server.on("upgrade", function(request, socket, body){
		if (!WebSocket.isWebSocket(request)) {
			return;
		}
		var ws = new WebSocket(request, socket, body);
		var httpInstance;
		ws.on('message', function(event) {
			var urlInfo = require("url").parse(event.target.url, true, true);
			var data = JSON.parse(event.data || "{}");
			data = extend(data, {
				host: urlInfo.hostname,
				write: function(data){
					return ws && ws.send(JSON.stringify(data));
				},
				end: function(){
					if (ws) {
						ws.close();
						ws = null;
					}
				}
			});
			var defaultHttp = thinkHttp.getDefaultHttp(data);
			httpInstance = thinkHttp(defaultHttp.req, defaultHttp.res);
			httpInstance.run(App.listener);
		});
		//websocket关闭
		ws.on('close', function(){
			if (httpInstance && httpInstance.http && httpInstance.http.emit) {
				httpInstance.http.emit("websocket.close");
			}
			ws = null;
		});
	});
};
/**
 * 监听回调函数
 * @param  {[type]} http [description]
 * @return {[type]}      [description]
 */
App.listener = function(http){
	"use strict";
	//自动发送thinkjs和版本的header
	http.setHeader("X-Powered-By", "thinkjs-" + THINK_VERSION);
	//禁止远程直接用带端口的访问，一般都是通过webserver做一层代理
	if (C('deny_remote_access_with_port') && http.host !== http.hostname) {
		http.res.statusCode = 403;
		http.res.end();
		return;
	}
	var instance = App(http);
	var domainInstance = domain.create();
	domainInstance.on("error", function(err){
		instance.sendError(err);
	});
	domainInstance.run(function(){
		return tag('app_init', http).then(function(){
			return instance.dispatch();
		}).then(function(){
			return tag('app_begin', http);
		}).then(function(){
			return tag('action_init', http);
		}).then(function(){
			return instance.exec();
		}).then(function(){
			return tag('app_end', http);
		}).catch(function(err){
			instance.sendError(err);
		});
	});
};