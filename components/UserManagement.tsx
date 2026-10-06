import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus, Pencil, Trash2, Shield, Mail, Calendar, User as UserIcon, CheckCircle, XCircle, Search } from 'lucide-react';

interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  status: string;
  last_login: string;
  created_at: string;
  parent_id?: number;
  permission_level?: string;
  subscription_expires_at?: string;
  last_active_at?: string;
  profile_count?: number;
  page_count?: number;
  business_count?: number;
  ad_account_count?: number;
}

// 时间格式化：兼容 MySQL "YYYY-MM-DD HH:mm:ss" 与 ISO 字符串
const fmtDateTime = (v?: string): string => {
  if (!v) return '';
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 相对时间（最后活跃展示）
const fmtRelative = (v?: string): string => {
  if (!v) return '从未活跃';
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
  const t = new Date(s).getTime();
  if (isNaN(t)) return String(v);
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return fmtDateTime(v);
};

export const UserManagement: React.FC<{ superAdmin?: boolean, token?: string | null }> = ({ superAdmin, token }) => {
  const { t } = useTranslation();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAddEmailModalOpen, setIsAddEmailModalOpen] = useState(false);
  const [targetEmail, setTargetEmail] = useState('');
  const [targetRole, setTargetRole] = useState('user');
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [userEmailFilter, setUserEmailFilter] = useState('');
  const [form, setForm] = useState({ 
    username: '', 
    password: '', 
    email: '', 
    role: superAdmin ? 'admin' : 'user', 
    status: 'active',
    permission_level: 'full',
    subscription_expires_at: ''
  });

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/users', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        }
      });
      const data = await response.json();
      if (data.success) {
        setUsers(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch users:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleAddMemberByEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetEmail) return;

    try {
      const response = await fetch('/api/users/add-member', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        },
        body: JSON.stringify({ email: targetEmail, role: targetRole })
      });
      const data = await response.json();
      if (data.success) {
        setIsAddEmailModalOpen(false);
        setTargetEmail('');
        setTargetRole('user');
        fetchUsers();
        alert('成员添加成功');
      } else {
        alert(data.message || '添加失败');
      }
    } catch (error) {
      alert('请求失败');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = editingUser ? `/api/users/${editingUser.id}` : '/api/users';
    const method = editingUser ? 'PUT' : 'POST';

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        },
        body: JSON.stringify(form)
      });
      const data = await response.json();
      if (data.success) {
        setIsModalOpen(false);
        setEditingUser(null);
        setForm({ 
          username: '', 
          password: '', 
          email: '', 
          role: superAdmin ? 'admin' : 'user', 
          status: 'active',
          permission_level: 'full',
          subscription_expires_at: ''
        });
        fetchUsers();
      } else {
        alert(data.message || data.error || '操作失败');
      }
    } catch (error) {
      alert('请求失败');
    }
  };

  const deleteUser = async (id: number) => {
    if (id === 1) return alert('不能删除初始管理员');
    if (!window.confirm('确定要删除该用户吗？')) return;

    try {
      const response = await fetch(`/api/users/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('auth_token')}`
        }
      });
      const data = await response.json();
      if (data.success) {
        fetchUsers();
      }
    } catch (error) {
      alert('删除失败');
    }
  };

  // 🚀 超级管理员邮箱筛选
  const filteredUsers = useMemo(() => {
    if (!userEmailFilter) return users;
    const f = userEmailFilter.toLowerCase();
    return users.filter(u => u.email.toLowerCase().includes(f));
  }, [users, userEmailFilter]);

  return (
    <div className="max-w-6xl mx-auto px-4">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold text-white">
            {superAdmin ? '超级管理员后台' : '团队管理'}
          </h2>
          <p className="text-slate-400">
            {superAdmin ? '全局用户、订阅与系统设置' : '管理您的团队成员及其权限'}
          </p>
        </div>
        <div className="flex gap-2">
          {!superAdmin && (
            <button
              onClick={() => setIsAddEmailModalOpen(true)}
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-all"
            >
              <Mail className="w-4 h-4" />
              通过邮箱添加
            </button>
          )}
          <button
            onClick={() => {
              setEditingUser(null);
              setForm({ 
                username: '', 
                password: '', 
                email: '', 
                role: superAdmin ? 'admin' : 'user', 
                status: 'active',
                permission_level: 'full',
                subscription_expires_at: ''
              });
              setIsModalOpen(true);
            }}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-all"
          >
            <UserPlus className="w-4 h-4" />
            {superAdmin ? '创建管理员' : '添加成员'}
          </button>
        </div>
      </div>

      {isAddEmailModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">通过邮箱添加成员</h3>
              <button onClick={() => setIsAddEmailModalOpen(false)} className="text-slate-400 hover:text-white p-2">
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            <form onSubmit={handleAddMemberByEmail} className="p-6 space-y-4">
              <p className="text-sm text-slate-400">输入对方注册本系统的邮箱，将其加入您的团队。</p>
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">用户邮箱</label>
                  <input 
                    type="email" 
                    required 
                    value={targetEmail} 
                    onChange={(e) => setTargetEmail(e.target.value)} 
                    placeholder="user@example.com"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500" 
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">分配角色</label>
                  <select 
                    value={targetRole} 
                    onChange={(e) => setTargetRole(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="user">执行员 (User)</option>
                    <option value="admin">团队长 (Admin)</option>
                  </select>
                </div>
              </div>
              <div className="pt-4 flex gap-3">
                <button type="button" onClick={() => setIsAddEmailModalOpen(false)} className="flex-1 px-4 py-2 bg-slate-800 text-slate-300 rounded-xl hover:bg-slate-700 transition-colors text-sm">取消</button>
                <button type="submit" className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 transition-colors text-sm">确认添加</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 🚀 超级管理员邮箱筛选 */}
      {superAdmin && (
        <div className="mb-4 flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              list="superAdminEmailList"
              value={userEmailFilter}
              onChange={e => setUserEmailFilter(e.target.value)}
              placeholder="输入/选择邮箱筛选..."
              className="w-72 bg-slate-950 border border-slate-700 rounded-xl pl-9 pr-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500 placeholder-slate-600"
            />
            <datalist id="superAdminEmailList">
              {users.map(u => <option key={u.id} value={u.email} />)}
            </datalist>
          </div>
          {userEmailFilter && (
            <button
              onClick={() => setUserEmailFilter('')}
              className="text-xs text-slate-400 hover:text-white transition-colors"
            >
              清除筛选
            </button>
          )}
          <span className="text-xs text-slate-500">
            {filteredUsers.length}/{users.length} 用户
          </span>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-950 text-slate-400 font-medium">
              <tr>
                <th className="px-6 py-4">成员名称</th>
                <th className="px-6 py-4">角色层级</th>
                <th className="px-6 py-4">资产数量</th>
                <th className="px-6 py-4">最后活跃</th>
                <th className="px-6 py-4">注册时间</th>
                <th className="px-6 py-4">数据权限</th>
                <th className="px-6 py-4">订阅到期</th>
                <th className="px-6 py-4">状态</th>
                <th className="px-6 py-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {loading ? (
                <tr><td colSpan={9} className="px-6 py-12 text-center text-slate-500">加载中...</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={9} className="px-6 py-12 text-center text-slate-500">暂无成员数据</td></tr>
              ) : (
                filteredUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-800/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-300">
                          <UserIcon className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-slate-200 font-medium">{user.username}</div>
                          <div className="text-[10px] text-slate-500">{user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${
                        user.role === 'superadmin' ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' :
                        user.role === 'admin' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' : 
                        'bg-blue-500/10 text-blue-500 border border-blue-500/20'
                      }`}>
                        {user.role === 'superadmin' ? '超级管理员' : user.role === 'admin' ? '团队长' : '执行员'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap items-center gap-1">
                        {[
                          { label: '配置', n: Number(user.profile_count || 0), cls: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20' },
                          { label: '主页', n: Number(user.page_count || 0), cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' },
                          { label: 'BM', n: Number(user.business_count || 0), cls: 'bg-sky-500/10 text-sky-300 border-sky-500/20' },
                          { label: '广告账户', n: Number(user.ad_account_count || 0), cls: 'bg-amber-500/10 text-amber-300 border-amber-500/20' },
                        ].filter(x => x.n > 0).map(x => (
                          <span key={x.label} className={`px-1.5 py-0.5 rounded border text-[10px] font-medium whitespace-nowrap ${x.cls}`}>
                            {x.label} {x.n}
                          </span>
                        ))}
                        {!Number(user.profile_count || 0) && !Number(user.page_count || 0) && !Number(user.business_count || 0) && !Number(user.ad_account_count || 0) && (
                          <span className="text-[11px] text-slate-600">无资产</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-slate-300 text-xs whitespace-nowrap" title={user.last_active_at ? fmtDateTime(user.last_active_at) : ''}>
                      {fmtRelative(user.last_active_at)}
                    </td>
                    <td className="px-6 py-4 text-slate-400 font-mono text-xs whitespace-nowrap" title={user.created_at ? fmtDateTime(user.created_at) : ''}>
                      {user.created_at ? fmtDateTime(user.created_at).slice(0, 10) : '—'}
                    </td>
                    <td className="px-6 py-4 text-slate-400">
                      {user.role === 'superadmin' ? '全量数据' : (user.permission_level === 'full' ? '全部可见' : user.permission_level === 'limited' ? '部分可见' : '仅自己')}
                    </td>
                    <td className="px-6 py-4 text-slate-400 font-mono text-xs">
                      {user.subscription_expires_at || '永久有效'}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${user.status === 'active' ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                        <span className={user.status === 'active' ? 'text-emerald-500' : 'text-rose-500 text-xs'}>
                          {user.status === 'active' ? '运行中' : '已锁定'}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => {
                            setEditingUser(user);
                            setForm({
                              username: user.username,
                              password: '',
                              email: user.email,
                              role: user.role,
                              status: user.status,
                              permission_level: user.permission_level || 'full',
                              subscription_expires_at: user.subscription_expires_at ? user.subscription_expires_at.slice(0, 10) : ''
                            });
                            setIsModalOpen(true);
                          }}
                          className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        {user.id !== 1 && user.role !== 'superadmin' && (
                          <button
                            onClick={() => deleteUser(user.id)}
                            className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <h3 className="text-xl font-bold text-white">
                {editingUser ? '编辑成员' : '添加新成员'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-white p-2">
                <XCircle className="w-6 h-6" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">成员名称</label>
                  <input type="text" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">登录邮箱</label>
                  <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500" />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-400">登录密码 {editingUser && '(留空不改)'}</label>
                <input type="password" required={!editingUser} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500" />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">身份层级</label>
                  <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500">
                    <option value="admin">团队长 (Admin)</option>
                    <option value="user">执行员 (User)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">数据权限</label>
                  <select value={form.permission_level} onChange={(e) => setForm({ ...form, permission_level: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500">
                    <option value="full">全部可见</option>
                    <option value="limited">部分可见</option>
                    <option value="own">仅限自己</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-400">账号状态</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500">
                  <option value="active">运行中 (Active)</option>
                  <option value="disabled">已锁定 (Disabled)</option>
                </select>
              </div>

              {superAdmin && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">订阅到期时间</label>
                  <input type="date" value={form.subscription_expires_at} onChange={(e) => setForm({ ...form, subscription_expires_at: e.target.value })} className="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2 text-white text-sm focus:ring-2 focus:ring-indigo-500" />
                </div>
              )}

              <div className="pt-4 flex gap-3">
                <button type="button" onClick={() => setIsModalOpen(false)} className="flex-1 px-4 py-2 bg-slate-800 text-slate-300 rounded-xl hover:bg-slate-700 transition-colors text-sm">取消</button>
                <button type="submit" className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-500 transition-colors text-sm">{editingUser ? '确认修改' : '立即创建'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
